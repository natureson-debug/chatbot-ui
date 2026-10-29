#define WIN32_LEAN_AND_MEAN
#include <winsock2.h>
#include <windows.h>
#include <ws2tcpip.h>
#include <string>
#include <cstdlib>
static volatile LONG stopping=0;
static BOOL WINAPI control(DWORD type){if(type==CTRL_C_EVENT){InterlockedExchange(&stopping,1);return TRUE;}return FALSE;}
int main(int argc,char**argv){
 if(argc!=4)return 90;const int port=atoi(argv[1]);const std::string model=argv[2],mode=argv[3];
 if(port<1024||port>65535||port==3000||port==8080||port==443||port==18080||!(model=="fixture-a"||model=="fixture-b"))return 90;
 if(mode=="fail")return 7;
 SetConsoleCtrlHandler(control,TRUE);WSADATA w;if(WSAStartup(MAKEWORD(2,2),&w))return 90;
 SOCKET s=socket(AF_INET,SOCK_STREAM,IPPROTO_TCP);BOOL exclusive=TRUE;setsockopt(s,SOL_SOCKET,SO_EXCLUSIVEADDRUSE,(char*)&exclusive,sizeof(exclusive));
 sockaddr_in a{};a.sin_family=AF_INET;a.sin_addr.s_addr=htonl(INADDR_LOOPBACK);a.sin_port=htons((u_short)port);
 if(bind(s,(sockaddr*)&a,sizeof(a))||listen(s,4))return 91;
 u_long nonblock=1;ioctlsocket(s,FIONBIO,&nonblock);auto end=GetTickCount64()+15000;
 while(GetTickCount64()<end && (!stopping||mode=="ignore")){
  SOCKET c=accept(s,nullptr,nullptr);if(c==INVALID_SOCKET){Sleep(10);continue;}
  DWORD timeout=200;setsockopt(c,SOL_SOCKET,SO_RCVTIMEO,(char*)&timeout,sizeof(timeout));
  char req[1024];recv(c,req,sizeof(req),0);
  const std::string body="{\"status\":\"ok\",\"model\":\""+model+"\"}";
  const std::string response="HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\nContent-Length: "+std::to_string(body.size())+"\r\n\r\n"+body;
  send(c,response.data(),(int)response.size(),0);closesocket(c);
 }
 closesocket(s);WSACleanup();return 0;
}
