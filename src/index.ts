// Process entry point: start the server and wire OS signals to graceful shutdown.

import { createChatServer } from "./server.js";

const server = createChatServer();
const port = await server.listen(Number(process.env.PORT ?? 3000), process.env.HOST ?? "127.0.0.1");
console.log(`realtime-chat on http://localhost:${port}  (WebSocket: ws://localhost:${port}/ws)`);

let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    if (stopping) process.exit(1); // second Ctrl-C forces exit
    stopping = true;
    console.log(`${signal} received, closing connections...`);
    await server.close();
    console.log("shutdown complete");
    process.exit(0);
  });
}
