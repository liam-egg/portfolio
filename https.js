const BASE_PATH = '/';
const { stat } = require('fs').promises;
Bun.serve({
    port: 443,
    certFile: "/etc/letsencrypt/live/liameggleston.com/cert.pem",
    keyFile: "/etc/letsencrypt/live/liameggleston.com/privkey.pem",

    async fetch(req) {
        try {
            let { pathname } = new URL(req.url);

            // Default route: serve index.html
            if (pathname === "/") {
                pathname = "/index.html";
            }

            const filePath = BASE_PATH + pathname;
            const file = Bun.file(filePath);

            // Check if file exists
            if (!(await file.exists())) {
                console.warn("File not found:", filePath);
                return new Response("Not found", { status: 404 });
            }

            console.log("Serving", filePath);
            return new Response(file);
        } catch (err) {
            console.error("Fetch Error:", err);
            return new Response("Server error", { status: 500 });
        }
    },
    
    error(err) {
        console.error("Server Error:", err);
        const file = Bun.file('/home/ubuntu/app/index.html');
        return new Response(file);
    }
})
