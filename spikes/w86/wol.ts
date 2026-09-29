/** W86 spike — Wake-on-LAN magic packet, shared helper. */
import dgram from "node:dgram";

export async function magicPacket(
	mac: string,
	target: string,
): Promise<boolean> {
	const clean = mac.replace(/[:-]/g, "").toLowerCase();
	if (clean.length !== 12) return false;
	const payload = Buffer.concat([
		Buffer.alloc(6, 0xff),
		Buffer.from(clean.repeat(16), "hex"),
	]);
	const [ip, portStr] = target.split(":");
	const port = Number(portStr || "9");
	return new Promise((resolve) => {
		const sock = dgram.createSocket("udp4");
		sock.bind(() => {
			sock.setBroadcast(true);
			sock.send(payload, port, ip, (err) => {
				sendFallback(sock, payload, port, ip, err, resolve);
			});
		});
	});
}

/** Broadcast to 192.168.1.255 can miss on some APs — also try 255.255.255.255. */
function sendFallback(
	sock: dgram.Socket,
	payload: Buffer,
	port: number,
	ip: string,
	err: Error | null,
	resolve: (ok: boolean) => void,
) {
	if (!err) {
		sock.close();
		resolve(true);
		return;
	}
	sock.send(payload, port, "255.255.255.255", (err2) => {
		sock.close();
		resolve(!err2);
	});
}
