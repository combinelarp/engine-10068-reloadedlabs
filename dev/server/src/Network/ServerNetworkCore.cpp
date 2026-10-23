#include "ServerNetworkCore.h"
#include "Network/ForkProtocol.h"
using namespace std::placeholders;
ServerNetworkCore::ServerNetworkCore(const char *ip, short port)
{
	strcpy(m_ip, ip);
	m_port = port;
	m_serverInstance = LORD::make_shared<RaknetInstance>(ip, port, std::chrono::milliseconds(25));
}


ServerNetworkCore::~ServerNetworkCore(void)
{

}

void ServerNetworkCore::host(ui32 maxSession)
{
	// Always install the C2S gateway. For stock 10068 clients it is a no-op
	// (ids pass through unchanged and they never send the fork's 179), so the
	// same binary still serves both; the 10096 fork client is detected purely
	// from its packet ids instead of a player pref that nothing ever sets.
	m_serverInstance->setPacketIdTranslator([](ui64 rakssid, ui16 id, const ui8* body, ui32 bodyLen) {
		RaknetInstance::ForkPacketHookResult res = ForkProtocol::onRecvC2S(rakssid, id, body, bodyLen);
		res.packetId = res.consumed ? RaknetInstance::kForkPacketConsumed : res.packetId;
		return res;
	});
	m_serverInstance->listen(maxSession);

}
void ServerNetworkCore::closeSession(const ui64 raknetId)
{
	m_serverInstance->closeSession(raknetId);
}


