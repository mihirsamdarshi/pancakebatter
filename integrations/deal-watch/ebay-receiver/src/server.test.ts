import { afterAll, describe, expect, test } from "bun:test";
import { connect, type Socket } from "node:net";
import { createCappedServer, HEADER_TIMEOUT_MS, MAX_CONNECTIONS } from "./server.ts";

const server = createCappedServer(async (req) => ({ status: 200, body: req.target }));
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const port = (server.address() as { port: number }).port;
afterAll(() => void server.close());

const open = (): Promise<Socket> =>
  new Promise((resolve) => {
    const s = connect(port, "127.0.0.1", () => resolve(s));
    s.on("error", () => {});
  });
const closedAfter = (s: Socket) => new Promise<number>((r) => { const t = Date.now(); s.on("close", () => r(Date.now() - t)); });

describe("connection caps and timeouts (design 3.2)", () => {
  test("serves a normal request", async () => {
    expect(await (await fetch(`http://127.0.0.1:${port}/ok`)).text()).toBe("/ok");
  });
  test("over-long header is refused with 400", async () => {
    const response = await fetch(`http://127.0.0.1:${port}/`, { headers: { "x-a": "a".repeat(20000) } }).catch(() => null);
    expect(response === null || response.status === 400).toBe(true);
  });
  test("a client that never finishes its headers is cut off at the header timeout", async () => {
    const s = await open();
    const closed = closedAfter(s);
    s.write("GET / HTTP/1.1\r\nHost: x\r\n");
    const ms = await closed;
    expect(ms).toBeGreaterThanOrEqual(HEADER_TIMEOUT_MS - 200);
    expect(ms).toBeLessThan(HEADER_TIMEOUT_MS + 1500);
  }, 10000);
  test("connections beyond the cap are closed", async () => {
    const held: Socket[] = [];
    for (let i = 0; i < MAX_CONNECTIONS; i++) held.push(await open());
    await Bun.sleep(100);
    const extra = await open();
    const closed = await Promise.race([closedAfter(extra).then(() => true), Bun.sleep(1000).then(() => false)]);
    expect(closed).toBe(true);
    for (const s of held) s.destroy();
  }, 15000);
});
