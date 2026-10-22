#include "common.h"
#include "fixture-pin.h" // Generated in TEMP: one absolute path and its SHA-256.
#include <bcrypt.h>
#include <ws2tcpip.h>
#include <iphlpapi.h>
#include <sstream>
#include <algorithm>

static_assert(sizeof(void*) == 8, "x64 only");
struct PendingWrite { HANDLE pipe; const std::string* bytes; bool complete=false; };
static DWORD WINAPI writer(void* argument) {
    auto& request=*static_cast<PendingWrite*>(argument); DWORD written=0;
    request.complete=WriteFile(request.pipe,request.bytes->data(),static_cast<DWORD>(request.bytes->size()),&written,nullptr) && written==request.bytes->size();
    return 0;
}
static void writeBounded(HANDLE pipeHandle,const std::string& bytes) {
    require(bytes.size()<=1024); PendingWrite request{pipeHandle,&bytes};
    Handle thread(CreateThread(nullptr,0,writer,&request,0,nullptr)); require(thread.get()!=nullptr);
    if(WaitForSingleObject(thread.get(),2000)!=WAIT_OBJECT_0) {
        CancelSynchronousIo(thread.get());
        // Never leave a worker using stack memory, or allow an unbounded IPC wait.
        if(WaitForSingleObject(thread.get(),1000)!=WAIT_OBJECT_0) ExitProcess(92);
        throw std::runtime_error("control-write-timeout");
    }
    require(request.complete);
}
static std::string hex(const BYTE* p, size_t n) {
    const char* digits = "0123456789abcdef"; std::string s;
    for(size_t i=0;i<n;++i) { s += digits[p[i]>>4]; s += digits[p[i]&15]; } return s;
}
static std::string nonce() {
    BYTE bytes[16]; require(BCryptGenRandom(nullptr, bytes, sizeof(bytes), BCRYPT_USE_SYSTEM_PREFERRED_RNG) == 0);
    return hex(bytes, sizeof(bytes));
}
static std::string hashFile(HANDLE file) {
    BCRYPT_ALG_HANDLE algorithm = nullptr; BCRYPT_HASH_HANDLE hash = nullptr;
    require(BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA256_ALGORITHM, nullptr, 0) == 0);
    try {
        require(BCryptCreateHash(algorithm, &hash, nullptr, 0, nullptr, 0, 0) == 0);
        BYTE bytes[16384]; DWORD count = 0;
        while(true) { require(ReadFile(file, bytes, sizeof(bytes), &count, nullptr) != 0); if(!count) break;
            require(BCryptHashData(hash, bytes, count, 0) == 0); }
        BYTE result[32]; require(BCryptFinishHash(hash, result, sizeof(result), 0) == 0);
        BCryptDestroyHash(hash); BCryptCloseAlgorithmProvider(algorithm, 0); return hex(result, sizeof(result));
    } catch(...) { if(hash) BCryptDestroyHash(hash); BCryptCloseAlgorithmProvider(algorithm, 0); throw; }
}
static std::wstring quote(const std::wstring& arg) {
    std::wstring result = L"\""; size_t slashes = 0;
    for(wchar_t c : arg) {
        if(c == L'\\') { ++slashes; continue; }
        result.append(c == L'"' ? slashes*2+1 : slashes, L'\\'); slashes=0; result += c;
    }
    result.append(slashes*2, L'\\'); return result + L'"';
}
static void pipe(Handle& read, Handle& write) {
    SECURITY_ATTRIBUTES sa{sizeof(sa), nullptr, TRUE}; HANDLE r=nullptr,w=nullptr;
    require(CreatePipe(&r,&w,&sa,0) != 0); read.reset(r); write.reset(w);
}
static bool portState(unsigned port, DWORD expectedPid, bool requireOwned) {
    ULONG size=0; DWORD result=GetExtendedTcpTable(nullptr,&size,FALSE,AF_INET,TCP_TABLE_OWNER_PID_LISTENER,0);
    require(result == ERROR_INSUFFICIENT_BUFFER);
    std::vector<BYTE> buffer(size);
    require(GetExtendedTcpTable(buffer.data(),&size,FALSE,AF_INET,TCP_TABLE_OWNER_PID_LISTENER,0) == NO_ERROR);
    auto table=reinterpret_cast<MIB_TCPTABLE_OWNER_PID*>(buffer.data()); unsigned matches=0;
    for(DWORD i=0;i<table->dwNumEntries;++i) { const auto& row=table->table[i];
        if(ntohs(static_cast<u_short>(row.dwLocalPort)) != port) continue;
        if(!requireOwned || row.dwOwningPid != expectedPid || row.dwLocalAddr != htonl(INADDR_LOOPBACK)) return false;
        ++matches;
    }
    size=0;
    require(GetExtendedTcpTable(nullptr,&size,FALSE,AF_INET6,TCP_TABLE_OWNER_PID_LISTENER,0)==ERROR_INSUFFICIENT_BUFFER);
    buffer.resize(size);
    require(GetExtendedTcpTable(buffer.data(),&size,FALSE,AF_INET6,TCP_TABLE_OWNER_PID_LISTENER,0)==NO_ERROR);
    auto table6=reinterpret_cast<MIB_TCP6TABLE_OWNER_PID*>(buffer.data());
    for(DWORD i=0;i<table6->dwNumEntries;++i) if(ntohs(static_cast<u_short>(table6->table[i].dwLocalPort))==port) return false;
    return requireOwned ? matches == 1 : matches == 0;
}

class Session {
    Handle job, process, input, output, error, image, lease;
    std::vector<Handle> directories;
    std::wstring directory, leasePath;
    bool attempted=false, finished=false, outputClosed=false, errorClosed=false;
    DWORD pid=0; FILETIME creation{}; unsigned port=0;
    std::string capturedOut, capturedError;
    void drain(Handle& pipeHandle, std::string& data, bool& closed) {
        if(closed) return;
        DWORD n=0;
        if(!PeekNamedPipe(pipeHandle.get(),nullptr,0,nullptr,&n,nullptr)) {
            require(GetLastError()==ERROR_BROKEN_PIPE); closed=true; pipeHandle.reset(); return;
        }
        if(n) { char b[512]; DWORD read=0;
            require(ReadFile(pipeHandle.get(),b,std::min<DWORD>(n,sizeof(b)),&read,nullptr) != 0);
            data.append(b,read); require(data.size()<=4096);
        }
    }
    void drainAll() { drain(output,capturedOut,outputClosed); drain(error,capturedError,errorClosed); }
    void pinImage() {
        const std::wstring exe=FIXTURE_PATH; require(exe.size()>3 && exe[1]==L':' && exe[2]==L'\\');
        directory=exe.substr(0,exe.find_last_of(L'\\'));
        // Ancestors cannot be renamed while held; reparse traversal is rejected.
        for(size_t pos=3;;) {
            const size_t end=directory.find(L'\\',pos);
            std::wstring part=end==std::wstring::npos?directory:directory.substr(0,end);
            Handle h(CreateFileW(part.c_str(),FILE_READ_ATTRIBUTES,FILE_SHARE_READ|FILE_SHARE_WRITE,nullptr,OPEN_EXISTING,FILE_FLAG_BACKUP_SEMANTICS|FILE_FLAG_OPEN_REPARSE_POINT,nullptr));
            require(h.get()!=INVALID_HANDLE_VALUE); BY_HANDLE_FILE_INFORMATION info{};
            require(GetFileInformationByHandle(h.get(),&info) && !(info.dwFileAttributes&FILE_ATTRIBUTE_REPARSE_POINT));
            directories.push_back(std::move(h)); if(end==std::wstring::npos) break; pos=end+1;
        }
        image.reset(CreateFileW(exe.c_str(),GENERIC_READ,FILE_SHARE_READ,nullptr,OPEN_EXISTING,FILE_FLAG_OPEN_REPARSE_POINT,nullptr));
        require(image.get()!=INVALID_HANDLE_VALUE); BY_HANDLE_FILE_INFORMATION info{};
        require(GetFileInformationByHandle(image.get(),&info) && !(info.dwFileAttributes&(FILE_ATTRIBUTE_REPARSE_POINT|FILE_ATTRIBUTE_DIRECTORY)));
        require(hashFile(image.get()) == FIXTURE_SHA256);
        leasePath=directory+L"\\fixture.test-lease";
        lease.reset(CreateFileW(leasePath.c_str(),GENERIC_READ|GENERIC_WRITE,0,nullptr,CREATE_NEW,FILE_ATTRIBUTE_NORMAL,nullptr));
        require(lease.get()!=INVALID_HANDLE_VALUE);
        const std::string marker="TEST unresolved\n"; DWORD written=0;
        require(WriteFile(lease.get(),marker.data(),static_cast<DWORD>(marker.size()),&written,nullptr) && written==marker.size() && FlushFileBuffers(lease.get()));
    }
    void verifyIdentity() {
        require(process.get()!=nullptr && WaitForSingleObject(process.get(),0)==WAIT_TIMEOUT);
        FILETIME c{},e{},k{},u{};
        require(GetProcessTimes(process.get(),&c,&e,&k,&u) && CompareFileTime(&creation,&c)==0 && GetProcessId(process.get())==pid);
        wchar_t path[32768]; DWORD count=32768;
        require(QueryFullProcessImageNameW(process.get(),0,path,&count) && _wcsicmp(path,FIXTURE_PATH)==0);
        BOOL inJob=FALSE; require(IsProcessInJob(process.get(),job.get(),&inJob) && inJob);
    }
    bool complete(DWORD milliseconds) {
        const ULONGLONG deadline=GetTickCount64()+milliseconds;
        do {
            drainAll(); DWORD state=WaitForSingleObject(process.get(),0); require(state!=WAIT_FAILED);
            if(state==WAIT_OBJECT_0 && outputClosed && errorClosed) {
                JOBOBJECT_BASIC_ACCOUNTING_INFORMATION info{};
                require(QueryInformationJobObject(job.get(),JobObjectBasicAccountingInformation,&info,sizeof(info),nullptr));
                if(info.ActiveProcesses==0 && (!port || portState(port,pid,false))) return true;
            }
            if(GetTickCount64()>=deadline) return false;
            Sleep(5);
        } while(true);
    }
    void release() {
        input.reset(); output.reset(); error.reset(); process.reset(); job.reset(); image.reset();
        lease.reset(); require(DeleteFileW(leasePath.c_str()) != 0); directories.clear(); finished=true;
    }
public:
    ~Session() {
        // Only this fixed fixture is subject to preauthorized crash/disconnect cleanup.
        if(process.get() && !finished) {
            job.reset();
            WaitForSingleObject(process.get(),3000);
            const ULONGLONG end=GetTickCount64()+1000;
            try { while(!(outputClosed&&errorClosed) && GetTickCount64()<end) { drainAll(); Sleep(5); } } catch(...) {}
        }
        // Abnormal completion retains the marker; never automatically reclaim it.
    }
    std::string start(const std::string& mode) {
        if(attempted) return "\"status\":\"duplicate-launch-rejected\"";
        require(mode=="cooperative" || mode=="ignore"); attempted=true; pinImage();
        job.reset(CreateJobObjectW(nullptr,nullptr)); require(job.get()!=nullptr);
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{}; limits.BasicLimitInformation.LimitFlags=JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        require(SetInformationJobObject(job.get(),JobObjectExtendedLimitInformation,&limits,sizeof(limits)) != 0);
        Handle childIn,childOut,childErr; pipe(childIn,input); pipe(output,childOut); pipe(error,childErr);
        require(SetHandleInformation(input.get(),HANDLE_FLAG_INHERIT,0) && SetHandleInformation(output.get(),HANDLE_FLAG_INHERIT,0) && SetHandleInformation(error.get(),HANDLE_FLAG_INHERIT,0));
        SIZE_T bytes=0; InitializeProcThreadAttributeList(nullptr,2,0,&bytes);
        std::vector<BYTE> storage(bytes); auto attrs=reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(storage.data());
        require(InitializeProcThreadAttributeList(attrs,2,0,&bytes) != 0);
        struct Attributes { LPPROC_THREAD_ATTRIBUTE_LIST p; ~Attributes(){DeleteProcThreadAttributeList(p);} } guard{attrs};
        HANDLE inherit[]={childIn.get(),childOut.get(),childErr.get()}, jobs[]={job.get()};
        require(UpdateProcThreadAttribute(attrs,0,PROC_THREAD_ATTRIBUTE_HANDLE_LIST,inherit,sizeof(inherit),nullptr,nullptr) != 0);
        require(UpdateProcThreadAttribute(attrs,0,PROC_THREAD_ATTRIBUTE_JOB_LIST,jobs,sizeof(jobs),nullptr,nullptr) != 0);
        STARTUPINFOEXW startup{}; startup.StartupInfo.cb=sizeof(startup); startup.lpAttributeList=attrs;
        startup.StartupInfo.dwFlags=STARTF_USESTDHANDLES; startup.StartupInfo.hStdInput=childIn.get(); startup.StartupInfo.hStdOutput=childOut.get(); startup.StartupInfo.hStdError=childErr.get();
        std::wstring command=quote(FIXTURE_PATH)+L" "+quote(L"--harmless-fixture-only")+L" "+quote(std::wstring(mode.begin(),mode.end()));
        for(const auto& arg:quoteCases()) command+=L" "+quote(arg);
        wchar_t windows[MAX_PATH]; require(GetWindowsDirectoryW(windows,MAX_PATH)>0);
        std::wstring env=L"SystemRoot="+std::wstring(windows); env.push_back(0); env.push_back(0);
        PROCESS_INFORMATION info{};
        require(CreateProcessW(FIXTURE_PATH,command.data(),nullptr,nullptr,TRUE,CREATE_SUSPENDED|CREATE_NO_WINDOW|CREATE_UNICODE_ENVIRONMENT|EXTENDED_STARTUPINFO_PRESENT,env.data(),directory.c_str(),&startup.StartupInfo,&info) != 0);
        process.reset(info.hProcess); Handle thread(info.hThread); pid=info.dwProcessId;
        FILETIME e{},k{},u{}; require(GetProcessTimes(process.get(),&creation,&e,&k,&u)); verifyIdentity();
        require(ResumeThread(thread.get()) != static_cast<DWORD>(-1)); childIn.reset(); childOut.reset(); childErr.reset();
        const ULONGLONG deadline=GetTickCount64()+5000;
        while(capturedOut.find('\n')==std::string::npos || capturedError.find('\n')==std::string::npos) {
            drainAll(); require(WaitForSingleObject(process.get(),0)==WAIT_TIMEOUT && GetTickCount64()<deadline); Sleep(5);
        }
        std::istringstream line(capturedOut); std::string ready,args; line>>ready>>port>>args;
        require(ready=="READY" && args=="ARGS_OK" && port>=1024 && port<=65535 && port!=8080 && port!=18080 && capturedError=="FIXTURE_STDERR\n");
        verifyIdentity(); require(portState(port,pid,true));
        const ULONGLONG stamp=(static_cast<ULONGLONG>(creation.dwHighDateTime)<<32)|creation.dwLowDateTime;
        return "\"status\":\"started\",\"operationId\":\"fixture-launch-1\",\"pid\":"+std::to_string(pid)+",\"creationTime\":\""+std::to_string(stamp)+"\",\"port\":"+std::to_string(port)+",\"identityVerified\":true,\"contained\":true,\"argumentsVerified\":true";
    }
    std::string stop(bool force) {
        require(process.get()!=nullptr && !finished); verifyIdentity();
        if(force) require(TerminateProcess(process.get(),77) != 0);
        else writeBounded(input.get(),"TEST_SHUTDOWN\n");
        if(!complete(force?3000:300)) return "\"status\":\"incomplete\"";
        DWORD code=0; require(GetExitCodeProcess(process.get(),&code)); release();
        return std::string("\"status\":\"")+(force?"forced-complete":"cooperative-complete")+"\",\"exitCode\":"+std::to_string(code)+",\"streamsClosed\":true,\"listenerReleased\":true";
    }
    std::string observe() { verifyIdentity(); require(portState(port,pid,true)); return "\"status\":\"owned\",\"identityVerified\":true"; }
    bool running() const { return process.get()!=nullptr && !finished; }
    void loseHandleForTest() { require(running()); process.reset(); throw std::runtime_error("ownership-lost"); }
};

static bool readLine(std::string& line) {
    line.clear(); const ULONGLONG deadline=GetTickCount64()+15000;
    while(GetTickCount64()<deadline) {
        DWORD available=0;
        if(!PeekNamedPipe(GetStdHandle(STD_INPUT_HANDLE),nullptr,0,nullptr,&available,nullptr)) { require(GetLastError()==ERROR_BROKEN_PIPE); return false; }
        if(available) { char c; DWORD n=0; require(ReadFile(GetStdHandle(STD_INPUT_HANDLE),&c,1,&n,nullptr) && n==1);
            if(c=='\n') return true;
            require(c>=32 && c<=126); line+=c; require(line.size()<=256);
        } else Sleep(5);
    } return false;
}
int wmain(int argc, wchar_t** argv) {
    try {
        require(argc==2 && std::wstring(argv[1])==L"--test-only"); require(nonElevated());
        require(GetFileType(GetStdHandle(STD_INPUT_HANDLE))==FILE_TYPE_PIPE && GetFileType(GetStdHandle(STD_OUTPUT_HANDLE))==FILE_TYPE_PIPE);
        const std::string token=nonce();
        // Warm Windows providers before measuring per-child owned-resource cleanup.
        require(portState(0,0,false));
        {
            Handle probe(CreateFileW(FIXTURE_PATH,GENERIC_READ,FILE_SHARE_READ,nullptr,OPEN_EXISTING,FILE_FLAG_OPEN_REPARSE_POINT,nullptr));
            require(probe.get()!=INVALID_HANDLE_VALUE && hashFile(probe.get())==FIXTURE_SHA256);
        }
        writeBounded(GetStdHandle(STD_OUTPUT_HANDLE),"");
        DWORD baseline=0; require(GetProcessHandleCount(GetCurrentProcess(),&baseline));
        writeBounded(GetStdHandle(STD_OUTPUT_HANDLE),"{\"version\":1,\"status\":\"hello\",\"token\":\""+token+"\",\"nonElevated\":true,\"handles\":"+std::to_string(baseline)+"}\n");
        Session session; unsigned expected=1, frames=0; std::string line;
        while(readLine(line)) {
            require(++frames<=10000); // Bounds work and prevents sequence-number wraparound.
            std::istringstream in(line); std::string version,sequence,received,command,arg,extra;
            in>>version>>sequence>>received>>command; in>>arg; in>>extra;
            std::string result;
            if(version!="V1" || sequence!=std::to_string(expected) || received!=token || !extra.empty()) result="\"status\":\"rejected\"";
            else {
                ++expected;
                if(command=="START" && (arg=="cooperative"||arg=="ignore")) result=session.start(arg);
                else if(command=="OBSERVE" && arg.empty()) result=session.observe();
                else if(command=="STOP" && arg.empty()) result=session.stop(false);
                else if(command=="FORCE" && arg=="AUTHORIZE") result=session.stop(true);
                else if(command=="CRASH_TEST" && arg.empty() && session.running()) ExitProcess(86);
                else if(command=="LOSE_HANDLE_TEST" && arg.empty()) session.loseHandleForTest();
                else if(command=="QUIT" && arg.empty() && !session.running()) break;
                else result="\"status\":\"rejected\"";
            }
            DWORD handles=0; require(GetProcessHandleCount(GetCurrentProcess(),&handles));
            writeBounded(GetStdHandle(STD_OUTPUT_HANDLE),"{\"version\":1,"+result+",\"nextSequence\":"+std::to_string(expected)+",\"handles\":"+std::to_string(handles)+",\"ownedHandles\":"+std::to_string(Handle::live.load())+"}\n");
        }
        return 0;
    } catch(...) {
        try { writeBounded(GetStdHandle(STD_OUTPUT_HANDLE),"{\"version\":1,\"status\":\"blocked\"}\n"); } catch(...) {}
        return 91;
    }
}
