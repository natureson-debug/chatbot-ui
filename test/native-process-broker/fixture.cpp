#include "common.h"
#include <ws2tcpip.h>

int wmain(int argc, wchar_t** argv) {
    try {
        require(nonElevated());
        require(argc == static_cast<int>(quoteCases().size()) + 3);
        require(std::wstring(argv[1]) == L"--harmless-fixture-only");
        const std::wstring mode = argv[2];
        require(mode == L"cooperative" || mode == L"ignore");
        for(size_t i = 0; i < quoteCases().size(); ++i) require(quoteCases()[i] == argv[i+3]);
        WSADATA data{}; require(WSAStartup(MAKEWORD(2,2), &data) == 0);
        SOCKET socket = ::socket(AF_INET, SOCK_STREAM, IPPROTO_TCP); require(socket != INVALID_SOCKET);
        BOOL exclusive = TRUE;
        require(setsockopt(socket, SOL_SOCKET, SO_EXCLUSIVEADDRUSE, reinterpret_cast<char*>(&exclusive), sizeof(exclusive)) == 0);
        sockaddr_in address{}; address.sin_family = AF_INET; address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
        require(bind(socket, reinterpret_cast<sockaddr*>(&address), sizeof(address)) == 0);
        int size = sizeof(address); require(getsockname(socket, reinterpret_cast<sockaddr*>(&address), &size) == 0);
        const unsigned port = ntohs(address.sin_port); require(port != 8080 && port != 18080);
        require(listen(socket, 1) == 0);
        writeFixed(GetStdHandle(STD_OUTPUT_HANDLE), "READY " + std::to_string(port) + " ARGS_OK\n");
        writeFixed(GetStdHandle(STD_ERROR_HANDLE), "FIXTURE_STDERR\n");
        const ULONGLONG deadline = GetTickCount64() + 30000;
        std::string input;
        while(GetTickCount64() < deadline) {
            DWORD available = 0;
            if(!PeekNamedPipe(GetStdHandle(STD_INPUT_HANDLE), nullptr, 0, nullptr, &available, nullptr)) break;
            if(available) {
                char c; DWORD read = 0;
                if(!ReadFile(GetStdHandle(STD_INPUT_HANDLE), &c, 1, &read, nullptr) || read != 1) break;
                if(c == '\n') {
                    if(input == "TEST_SHUTDOWN" && mode == L"cooperative") break;
                    input.clear();
                } else { input += c; require(input.size() <= 64); }
            } else Sleep(5);
        }
        closesocket(socket); WSACleanup(); return 0;
    } catch(...) { return 90; }
}
