#include "common.h"
#include "profile.h" // Generated in TEMP: one absolute path and its SHA-256.
#include <bcrypt.h>
#include <sddl.h>
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
        if(!requireOwned || row.dwOwningPid != expectedPid || row.dwLocalAddr != htonl(EXPECTED_ADDRESS)) return false;
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


static BOOL WINAPI consoleHandler(DWORD) { return TRUE; }
class Managed {
    Handle process, out, err, image, lease;
    std::vector<Handle> pins, directories;
    FILETIME created{}; DWORD pid=0; bool attempted=false, closedOut=false, closedErr=false;
    bool done=false, signalled=false; std::string line;
    unsigned offloaded=0, totalLayers=0; bool cudaModel=false, cudaKV=false;
    void drain(Handle& h,bool& closed) {
        if(closed)return;
        DWORD available=0;
        if(!PeekNamedPipe(h.get(),nullptr,0,nullptr,&available,nullptr)){
            require(GetLastError()==ERROR_BROKEN_PIPE);closed=true;h.reset();return;
        }
        if(!available)return;
        char b[4096];DWORD n=0;require(ReadFile(h.get(),b,std::min<DWORD>(available,sizeof(b)),&n,nullptr));
        for(DWORD i=0;i<n;i++){
            if(b[i]=='\n'){
                // Only fixed initialization facts leave the broker, never arbitrary child output.
                const auto at=line.find("offloaded ");
                if(at!=std::string::npos) {
                    unsigned a=0,t=0;
                    if(sscanf_s(line.c_str()+at,"offloaded %u/%u layers",&a,&t)==2&&a<=t&&t<10000){offloaded=a;totalLayers=t;}
                }
                if(line.find("CUDA0 model buffer size")!=std::string::npos)cudaModel=true;
                if(line.find("CUDA0 KV buffer size")!=std::string::npos)cudaKV=true;
                line.clear();
            }else if(line.size()<1024)line+=b[i];
        }
    }
    void identity() {
        require(process.get()&&WaitForSingleObject(process.get(),0)==WAIT_TIMEOUT);
        FILETIME c{},e{},k{},u{}; wchar_t path[32768];DWORD size=32768;
        require(GetProcessTimes(process.get(),&c,&e,&k,&u)&&CompareFileTime(&c,&created)==0);
        require(GetProcessId(process.get())==pid&&QueryFullProcessImageNameW(process.get(),0,path,&size)&&_wcsicmp(path,TARGET_PATH)==0);
    }
    bool releaseIfComplete(){
        drain(out,closedOut);drain(err,closedErr);
        if(!process.get()||WaitForSingleObject(process.get(),0)!=WAIT_OBJECT_0||!closedOut||!closedErr)return false;
        if(!portState(EXPECTED_PORT,pid,false))return false;
        process.reset();out.reset();err.reset();image.reset();pins.clear();lease.reset();
        require(DeleteFileW(LEASE_PATH));directories.clear();done=true;return true;
    }
public:
    ~Managed(){
        // Broken control output is also supervisor loss. Attempt ONE cooperative signal.
        // No force operation; an incomplete stop keeps this broker/lease alive.
        if(process.get()&&!done){
            try{stop();while(!done){status();Sleep(100);}}catch(...){}
        }
    }
    bool started()const{return attempted;}
    bool finished()const{return done;}
    bool live()const{return process.get()&&WaitForSingleObject(process.get(),0)==WAIT_TIMEOUT;}
    void poll(){drain(out,closedOut);drain(err,closedErr);}
    std::string start(){
        if(attempted)return "\"status\":\"duplicate-launch-rejected\"";
        attempted=true;
        require(portState(EXPECTED_PORT,0,false));
        // Hold ancestor directories against replacement, rejecting reparse traversal.
        std::vector<std::wstring> protectedPaths{LEASE_PATH};
        for(const auto& pin:PINNED_FILES)protectedPaths.push_back(pin.first);
        for(const auto& file:protectedPaths){
            require(file.size()>3&&file[1]==L':'&&file[2]==L'\\');
            const auto directory=file.substr(0,file.find_last_of(L'\\'));
            for(size_t pos=3;;){
                const size_t end=directory.find(L'\\',pos);
                const auto part=end==std::wstring::npos?directory:directory.substr(0,end);
                Handle h(CreateFileW(part.c_str(),FILE_READ_ATTRIBUTES,FILE_SHARE_READ|FILE_SHARE_WRITE,nullptr,OPEN_EXISTING,FILE_FLAG_BACKUP_SEMANTICS|FILE_FLAG_OPEN_REPARSE_POINT,nullptr));
                require(h.get()!=INVALID_HANDLE_VALUE);BY_HANDLE_FILE_INFORMATION info{};
                require(GetFileInformationByHandle(h.get(),&info)&&!(info.dwFileAttributes&FILE_ATTRIBUTE_REPARSE_POINT));
                directories.push_back(std::move(h));if(end==std::wstring::npos)break;pos=end+1;
            }
        }
        // CREATE_NEW is an installation/service lifetime lease. Never reclaim stale leases.
        lease.reset(CreateFileW(LEASE_PATH,GENERIC_READ|GENERIC_WRITE,0,nullptr,CREATE_NEW,FILE_ATTRIBUTE_NORMAL,nullptr));
        require(lease.get()!=INVALID_HANDLE_VALUE);
        DWORD n=0;const char marker[]="unresolved-owned-launch\n";
        require(WriteFile(lease.get(),marker,sizeof(marker)-1,&n,nullptr)&&FlushFileBuffers(lease.get()));
        for(const auto& pin:PINNED_FILES){
            Handle h(CreateFileW(pin.first.c_str(),GENERIC_READ,FILE_SHARE_READ,nullptr,OPEN_EXISTING,FILE_FLAG_OPEN_REPARSE_POINT,nullptr));
            require(h.get()!=INVALID_HANDLE_VALUE);BY_HANDLE_FILE_INFORMATION info{};
            require(GetFileInformationByHandle(h.get(),&info)&&!(info.dwFileAttributes&FILE_ATTRIBUTE_REPARSE_POINT));
            require(hashFile(h.get())==pin.second);pins.push_back(std::move(h));
        }
        require(GetConsoleWindow()!=nullptr);
        Handle childOut,childErr,unused; pipe(out,childOut);pipe(err,childErr);
        require(SetHandleInformation(out.get(),HANDLE_FLAG_INHERIT,0)&&SetHandleInformation(err.get(),HANDLE_FLAG_INHERIT,0));
        SECURITY_ATTRIBUTES sa{sizeof(sa),nullptr,TRUE};
        Handle input(CreateFileW(L"NUL",GENERIC_READ,FILE_SHARE_READ|FILE_SHARE_WRITE,&sa,OPEN_EXISTING,0,nullptr));
        require(input.get()!=INVALID_HANDLE_VALUE);
        SIZE_T bytes=0;InitializeProcThreadAttributeList(nullptr,1,0,&bytes);
        std::vector<BYTE> storage(bytes);auto attrs=reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(storage.data());
        require(InitializeProcThreadAttributeList(attrs,1,0,&bytes));
        struct Guard{LPPROC_THREAD_ATTRIBUTE_LIST p;~Guard(){DeleteProcThreadAttributeList(p);}}guard{attrs};
        HANDLE inherited[]={input.get(),childOut.get(),childErr.get()};
        require(UpdateProcThreadAttribute(attrs,0,PROC_THREAD_ATTRIBUTE_HANDLE_LIST,inherited,sizeof(inherited),nullptr,nullptr));
        STARTUPINFOEXW si{};si.StartupInfo.cb=sizeof(si);si.lpAttributeList=attrs;
        si.StartupInfo.dwFlags=STARTF_USESTDHANDLES;si.StartupInfo.hStdInput=input.get();si.StartupInfo.hStdOutput=childOut.get();si.StartupInfo.hStdError=childErr.get();
        std::wstring cmd=quote(TARGET_PATH);for(const auto& arg:TARGET_ARGS)cmd+=L" "+quote(arg);
        PROCESS_INFORMATION pi{};
        // Inherit this broker's PRIVATE console; no process-group-wide signal elsewhere.
        std::wstring environment;
        for(const wchar_t* key:{L"APPDATA",L"LOCALAPPDATA",L"SystemRoot",L"TEMP",L"TMP",L"USERPROFILE",L"WINDIR"}){
            wchar_t value[32768];DWORD size=GetEnvironmentVariableW(key,value,32768);require(size>0&&size<32768);
            environment+=key;environment+=L"=";environment+=value;environment.push_back(0);
        }
        environment.push_back(0);
        require(CreateProcessW(TARGET_PATH,cmd.data(),nullptr,nullptr,TRUE,EXTENDED_STARTUPINFO_PRESENT|CREATE_UNICODE_ENVIRONMENT,environment.data(),TARGET_CWD,&si.StartupInfo,&pi));
        process.reset(pi.hProcess);Handle thread(pi.hThread);pid=pi.dwProcessId;
        FILETIME e{},k{},u{};require(GetProcessTimes(process.get(),&created,&e,&k,&u));identity();
        childOut.reset();childErr.reset();input.reset();
        return status();
    }
    std::string status(){
        if(done)return "\"status\":\"exited\",\"streamsClosed\":true,\"listenerReleased\":true";
        require(process.get()!=nullptr);
        if(releaseIfComplete())return "\"status\":\"exited\",\"streamsClosed\":true,\"listenerReleased\":true";
        if(!live())return "\"status\":\"exit-pending\"";
        identity();bool listener=portState(EXPECTED_PORT,pid,true);
        // A conflicting listener is different from an absent listener.
        if(!listener&&!portState(EXPECTED_PORT,pid,false))throw std::runtime_error("foreign-listener");
        const auto stamp=(static_cast<ULONGLONG>(created.dwHighDateTime)<<32)|created.dwLowDateTime;
        return "\"status\":\"owned\",\"pid\":"+std::to_string(pid)+",\"created\":\""+std::to_string(stamp)+"\",\"listener\":"+(listener?"true":"false")+
        ",\"offloaded\":"+std::to_string(offloaded)+",\"totalLayers\":"+std::to_string(totalLayers)+",\"cudaModel\":"+(cudaModel?"true":"false")+",\"cudaKV\":"+(cudaKV?"true":"false");
    }
    std::string stop(){
        if(releaseIfComplete())return "\"status\":\"exited\",\"streamsClosed\":true,\"listenerReleased\":true";
        identity();
        // Original retained process must still live, and only it and this broker may share console.
        DWORD ids[16];DWORD count=GetConsoleProcessList(ids,16);require(count==2);
        bool self=false,child=false;for(DWORD i=0;i<count;i++){self|=ids[i]==GetCurrentProcessId();child|=ids[i]==pid;}require(self&&child);
        if(!signalled){require(GenerateConsoleCtrlEvent(CTRL_C_EVENT,0));signalled=true;}
        const auto deadline=GetTickCount64()+SHUTDOWN_MS;
        while(GetTickCount64()<deadline){if(releaseIfComplete())return "\"status\":\"graceful-complete\",\"streamsClosed\":true,\"listenerReleased\":true";Sleep(10);}
        return "\"status\":\"incomplete\""; // Retain handle/lease; NO forced termination.
    }
};
static int bridge(){
    wchar_t self[32768];require(GetModuleFileNameW(nullptr,self,32768)>0);
    HANDLE handles[]={GetStdHandle(STD_INPUT_HANDLE),GetStdHandle(STD_OUTPUT_HANDLE),GetStdHandle(STD_ERROR_HANDLE)};
    for(auto h:handles)require(SetHandleInformation(h,HANDLE_FLAG_INHERIT,HANDLE_FLAG_INHERIT));
    SIZE_T size=0;InitializeProcThreadAttributeList(nullptr,1,0,&size);std::vector<BYTE> bytes(size);
    auto attrs=reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(bytes.data());require(InitializeProcThreadAttributeList(attrs,1,0,&size));
    struct Guard{LPPROC_THREAD_ATTRIBUTE_LIST p;~Guard(){DeleteProcThreadAttributeList(p);}}guard{attrs};
    require(UpdateProcThreadAttribute(attrs,0,PROC_THREAD_ATTRIBUTE_HANDLE_LIST,handles,sizeof(handles),nullptr,nullptr));
    STARTUPINFOEXW si{};si.StartupInfo.cb=sizeof(si);si.lpAttributeList=attrs;si.StartupInfo.dwFlags=STARTF_USESTDHANDLES;
    si.StartupInfo.hStdInput=handles[0];si.StartupInfo.hStdOutput=handles[1];si.StartupInfo.hStdError=handles[2];
    PROCESS_INFORMATION pi{};auto command=quote(self)+L" --managed";
    // Escape libuv's kill-on-supervisor-exit job, not process supervision or private IPC.
    require(CreateProcessW(self,command.data(),nullptr,nullptr,TRUE,EXTENDED_STARTUPINFO_PRESENT|CREATE_BREAKAWAY_FROM_JOB|CREATE_NO_WINDOW,nullptr,nullptr,&si.StartupInfo,&pi));
    Handle process(pi.hProcess),thread(pi.hThread);BOOL inJob=TRUE;
    require(IsProcessInJob(process.get(),nullptr,&inJob)&&!inJob);
    require(WaitForSingleObject(process.get(),INFINITE)==WAIT_OBJECT_0);
    DWORD code=0;require(GetExitCodeProcess(process.get(),&code));return static_cast<int>(code);
}
int wmain(int argc,wchar_t** argv){
    try{
        require(argc==2&&(std::wstring(argv[1])==L"--managed"||std::wstring(argv[1])==L"--bridge"));require(nonElevated());
        HANDLE rawToken=nullptr;require(OpenProcessToken(GetCurrentProcess(),TOKEN_QUERY,&rawToken));Handle tokenHandle(rawToken);
        DWORD tokenSize=0;GetTokenInformation(rawToken,TokenUser,nullptr,0,&tokenSize);std::vector<BYTE> tokenData(tokenSize);
        require(GetTokenInformation(rawToken,TokenUser,tokenData.data(),tokenSize,&tokenSize));
        LPWSTR userSid=nullptr;require(ConvertSidToStringSidW(reinterpret_cast<TOKEN_USER*>(tokenData.data())->User.Sid,&userSid));
        const bool expectedUser=std::wstring(userSid)==OPERATOR_SID;LocalFree(userSid);require(expectedUser); if(std::wstring(argv[1])==L"--bridge")return bridge(); BOOL inJob=TRUE;require(IsProcessInJob(GetCurrentProcess(),nullptr,&inJob)&&!inJob);
        HANDLE controlIn=GetStdHandle(STD_INPUT_HANDLE),controlOut=GetStdHandle(STD_OUTPUT_HANDLE);
        require(SetHandleInformation(controlIn,HANDLE_FLAG_INHERIT,0)&&SetHandleInformation(controlOut,HANDLE_FLAG_INHERIT,0));
        SetHandleInformation(GetStdHandle(STD_ERROR_HANDLE),HANDLE_FLAG_INHERIT,0);
        require(GetFileType(controlIn)==FILE_TYPE_PIPE&&GetFileType(controlOut)==FILE_TYPE_PIPE);
        // Never attach to an existing user's console.
        FreeConsole(); // Detach inherited headless/pseudoconsole as well as visible consoles.
        require(AllocConsole());require(SetConsoleCtrlHandler(nullptr,FALSE));ShowWindow(GetConsoleWindow(),SW_HIDE);require(SetConsoleCtrlHandler(consoleHandler,TRUE));
        const std::string token=nonce();unsigned sequence=1;std::string line;Managed child;
        writeBounded(controlOut,"{\"status\":\"hello\",\"version\":1,\"token\":\""+token+"\",\"nonElevated\":true}\n");
        ULONGLONG last=GetTickCount64();
        while(true){
            if(child.started()&&!child.finished())child.poll();
            DWORD n=0;
            if(!PeekNamedPipe(controlIn,nullptr,0,nullptr,&n,nullptr)){
                require(GetLastError()==ERROR_BROKEN_PIPE);
                if(child.started()&&!child.finished()){
                    try{child.stop();}catch(...){}
                    // Incomplete cooperative shutdown keeps broker and lease alive.
                    while(!child.finished()){try{child.status();}catch(...){}Sleep(100);}
                }
                return 0;
            }
            if(!n){Sleep(10);continue;}
            char c;DWORD got=0;require(ReadFile(controlIn,&c,1,&got,nullptr)&&got==1);
            if(c!='\n'){require(c>=32&&c<=126&&line.size()<256);line+=c;continue;}
            std::istringstream in(line);std::string v,s,t,cmd,extra;in>>v>>s>>t>>cmd>>extra;line.clear();
            std::string result="\"status\":\"rejected\"";
            if(v=="V1"&&s==std::to_string(sequence)&&t==token&&extra.empty()){
                ++sequence;
                #if TEST_PROFILE
                if(cmd=="CRASH_FIXTURE_BROKER"&&child.started())ExitProcess(86);
#endif
                if(cmd=="START")result=child.start();
                else if(cmd=="STATUS")result=child.status();
                else if(cmd=="STOP")result=child.stop();
                else if(cmd=="QUIT"&&(!child.started()||child.finished()))return 0;
            }
            writeBounded(controlOut,"{"+result+",\"nextSequence\":"+std::to_string(sequence)+"}\n");last=GetTickCount64();(void)last;
        }
    }catch(...){return 91;} // No automatic terminate; stale lease prevents replacement.
}
