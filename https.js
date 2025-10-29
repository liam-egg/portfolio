const BASE_PATH = '.';
const { stat } = require('fs').promises;

Bun.serve({
    port: 443,
    certFile: "./cert.pem",
    keyFile: "./privkey.pem",

    async fetch(req) {
        try {
            let { pathname } = new URL(req.url);

            // Normalize path
            if (pathname === "/") {
                pathname = "/index.html";
            }

            // Prevent access to sensitive files
            const forbiddenFiles = [
                "/cert.pem",
                "/privkey.pem",
                "/https.js"
            ];
            if (forbiddenFiles.includes(pathname) || pathname.includes("..")) {
                console.warn("Attempted access to forbidden file:", pathname);
                return new Response("Forbidden", { status: 403 });
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
        const file = Bun.file('./index.html');
        return new Response(file);
    }
});
