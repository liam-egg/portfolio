const BASE_PATH = '.';
const { stat } = require('fs').promises;

Bun.serve({
	port: 443,
	certFile: "/etc/letsencrypt/live/liameggleston.com/cert.pem",
	keyFile: "/etc/letsencrypt/live/liameggleston.com/privkey.pem",
	async fetch (req) {
		try {
			if (req.url == "https://liameggleston.com/") return new Response(Bun.file('./index.html'));
			const filePath = BASE_PATH + new URL(req.url).pathname;
			const file = Bun.file(filePath);
			return new Response(file);
		} catch (err) {
			console.error("Fetch Error:", err);
			return new Response(null, { status: 400 });
		}
	},
	error (err) {
		console.error("Server Error:", err);
		const file = Bun.file('/home/ubuntu/app/index.html');
		return new Response(file);
	}
});
Bun.serve({
	port: 80,
	hostname: "0.0.0.0",
	async fetch (req) {
		return new Response(null, {
			status: 301,
			headers: {
				'Location': "https://liameggleston.com" + new URL(req.url).pathname
			}
		});
	},
	error () {
		return new Response(null, { status: 404 });
	}
});
