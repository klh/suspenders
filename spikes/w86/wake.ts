/**
 * W86 spike — wake the hibernating Synology (WoL) and poll until its
 * services answer. Synology hibernation: NIC answers ARP but TCP SYNs are
 * dropped; only a magic packet brings services back.
 *
 * Run: bun spikes/w86/wake.ts
 */
import dgram from "node:dgram";

const NAS = "192.168.1.73";
const MAC = "90:09:d0:5a:ff:8f";

function magicPacket(mac: string): Buffer {
	const clean = mac.replace(/[:\-]/g, "").toLowerCase();
	if (clean.length !== 12) throw new Error(`bad MAC: ${mac}`);
	return Buffer.concat([
		Buffer.alloc(6, 0xff),
		Buffer.from(clean.repeat(16), "hex"),
	]);
}

function sendWoL(): Promise<void> {
	return new Promise((resolve, reject) => {
		const sock = dgram.createSocket("udp4");
		sock.bind(() => {
			sock.setBroadcast(true);
			sock.send(magicPacket(MAC), 9, "192.168.1.255", (err) => {
				sock.close();
				if (err) reject(err);
				else resolve();
			});
		});
	});
}

async function probePort(port: number, path = "/"): Promise<number | null> {
	try {
		const r = await fetch(`http://${NAS}:${port}${path}`, {
			signal: AbortSignal.timeout(1500),
		});
		return r.status;
	} catch {
		return null;
	}
}

await sendWoL();
console.log(`[w86] WoL magic packet sent to ${MAC} via 192.168.1.255:9`);

const deadline = Date.now() + 120_000;
let firstLive: string | null = null;
while (Date.now() < deadline) {
	await new Promise((r) => setTimeout(r, 4000));
	const dsm = await probePort(5000);
	const ml = await probePort(3003, "/ping");
	if (dsm || ml) {
		firstLive = `dsm:5000=${dsm ?? "-"} ml:3003/ping=${ml ?? "-"}`;
		break;
	}
	console.log(
		`[w86] waiting for ${NAS} ... ${Math.round((deadline - Date.now()) / 1000)}s left`,
	);
}

console.log(
	firstLive ? `[w86] ALIVE: ${firstLive}` : "[w86] no response in 120s",
);
