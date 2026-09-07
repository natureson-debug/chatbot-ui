const http = require("http");
const fs = require("fs");
const path = require("path");

const HOST = "0.0.0.0";
const PORT = 3000;

const LLAMA_URL = "http://192.168.100.1:8080/v1/chat/completions";
const API_KEY_FILE = "C:\\AI\\config\\llama-api-key.txt";
const PUBLIC_DIR = path.join(__dirname, "public");

const apiKey = fs.readFileSync(API_KEY_FILE, "utf8").trim();

const contentTypes = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8"
};

function serveFile(res, filePath) {
    fs.readFile(filePath, (error, data) => {
        if (error) {
            res.writeHead(404, {
                "Content-Type": "text/plain; charset=utf-8"
            });
            res.end("Not found");
            return;
        }

        const ext = path.extname(filePath).toLowerCase();

        res.writeHead(200, {
            "Content-Type": contentTypes[ext] || "application/octet-stream"
        });

        res.end(data);
    });
}

const server = http.createServer(async (req, res) => {

    // Health check
    if (req.method === "GET" && req.url === "/health") {
        res.writeHead(200, {
            "Content-Type": "application/json"
        });

        res.end(JSON.stringify({
            status: "ok",
            backend: "chatbot-ui",
            llama: "192.168.100.1:8080"
        }));

        return;
    }

    // Streaming chat proxy
    if (req.method === "POST" && req.url === "/api/chat") {
        try {
            let body = "";

            for await (const chunk of req) {
                body += chunk;
            }

            const clientRequest = JSON.parse(body);

            if (!Array.isArray(clientRequest.messages)) {
                res.writeHead(400, {
                    "Content-Type": "application/json"
                });

                res.end(JSON.stringify({
                    error: "messages must be an array"
                }));

                return;
            }

            const llamaRequest = {
                model: "Qwen3-4B-Q4_K_M",
                messages: clientRequest.messages,
                temperature: clientRequest.temperature ?? 0.7,
                max_tokens: clientRequest.max_tokens ?? 512,
                stream: true,

                chat_template_kwargs: {
                    enable_thinking:
                        clientRequest.enable_thinking ?? false
                }
            };

            const upstream = await fetch(LLAMA_URL, {
                method: "POST",
                headers: {
                    "Authorization": `Bearer ${apiKey}`,
                    "Content-Type": "application/json"
                },
                body: JSON.stringify(llamaRequest)
            });

            if (!upstream.ok) {
                const errorText = await upstream.text();

                res.writeHead(upstream.status, {
                    "Content-Type": "text/plain"
                });

                res.end(errorText);
                return;
            }

            res.writeHead(200, {
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache",
                "Connection": "keep-alive"
            });

            const reader = upstream.body.getReader();

            while (true) {
                const { done, value } = await reader.read();

                if (done) break;

                res.write(Buffer.from(value));
            }

            res.end();

        } catch (error) {
            console.error(error);

            if (!res.headersSent) {
                res.writeHead(500, {
                    "Content-Type": "application/json"
                });
            }

            res.end(JSON.stringify({
                error: error.message
            }));
        }

        return;
    }

    // Static browser files
    if (req.method === "GET") {
        let requestedPath =
            req.url === "/" ? "/index.html" : req.url;

        requestedPath = requestedPath.split("?")[0];

        const safePath = path.normalize(requestedPath)
            .replace(/^(\.\.[/\\])+/, "");

        const filePath = path.join(PUBLIC_DIR, safePath);

        if (!filePath.startsWith(PUBLIC_DIR)) {
            res.writeHead(403);
            res.end("Forbidden");
            return;
        }

        serveFile(res, filePath);
        return;
    }

    res.writeHead(404, {
        "Content-Type": "text/plain"
    });

    res.end("Not found");
});

server.listen(PORT, HOST, () => {
    console.log("");
    console.log("Local AI Chatbot");
    console.log("----------------");
    console.log(`UI:    http://${HOST}:${PORT}`);
    console.log(`Llama: ${LLAMA_URL}`);
    console.log("");
});
