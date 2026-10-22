#pragma once
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <winsock2.h>
#include <windows.h>
#include <string>
#include <vector>
#include <stdexcept>
#include <utility>
#include <atomic>

// TEST fixtures only. No runtime/HTTP application includes this code.
struct Handle {
    inline static std::atomic<unsigned> live{0};
    HANDLE value = nullptr;
    Handle() = default;
    explicit Handle(HANDLE h) : value(h) { if(valid(h)) ++live; }
    Handle(const Handle&) = delete;
    Handle& operator=(const Handle&) = delete;
    Handle(Handle&& h) noexcept : value(std::exchange(h.value, nullptr)) {}
    Handle& operator=(Handle&& h) noexcept { if(this!=&h) {reset();value=std::exchange(h.value,nullptr);} return *this; }
    ~Handle() { reset(); }
    static bool valid(HANDLE h) { return h && h!=INVALID_HANDLE_VALUE; }
    void reset(HANDLE h = nullptr) {
        if(valid(value)) { if(!CloseHandle(value)) ExitProcess(94); --live; }
        value=h; if(valid(h)) ++live;
    }
    HANDLE get() const { return value; }
};
inline void require(bool ok) { if(!ok) throw std::runtime_error("test-operation-failed"); }
inline bool nonElevated() {
    Handle token; HANDLE raw = nullptr;
    if(!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &raw)) return false;
    token.reset(raw); TOKEN_ELEVATION e{}; DWORD size = 0;
    if(!GetTokenInformation(token.get(), TokenElevation, &e, sizeof(e), &size) || e.TokenIsElevated) return false;
    GetTokenInformation(token.get(), TokenIntegrityLevel, nullptr, 0, &size);
    std::vector<BYTE> data(size);
    if(!size || !GetTokenInformation(token.get(), TokenIntegrityLevel, data.data(), size, &size)) return false;
    auto sid = reinterpret_cast<TOKEN_MANDATORY_LABEL*>(data.data())->Label.Sid;
    return *GetSidSubAuthority(sid, *GetSidSubAuthorityCount(sid)-1) < SECURITY_MANDATORY_HIGH_RID;
}
inline void writeFixed(HANDLE h, const std::string& s) {
    DWORD n = 0;
    require(WriteFile(h, s.data(), static_cast<DWORD>(s.size()), &n, nullptr) && n == s.size());
}
inline const std::vector<std::wstring>& quoteCases() {
    static const std::vector<std::wstring> cases = {L"", L"with spaces", L"quote\"inside", L"trailing\\", L"space and trailing\\", L"\\\"", L"Unicode-\u03a9-\u4e2d-\U0001f600"};
    return cases;
}
