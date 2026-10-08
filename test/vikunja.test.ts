import { describe, expect, it } from "vitest";
import { createVikunja } from "../src/vikunja.js";
import { fakeApi, TOKEN } from "./helpers.js";

const client = (fetch: typeof globalThis.fetch) => createVikunja({ url: "https://tasks.test/sub", token: TOKEN, fetch });

describe("createVikunja", () => {
  it("authenticates API calls but not the public info endpoint", async () => {
    const api = fakeApi({ "GET /info": () => ({ version: "v2.6.0" }), "GET /tasks/1": () => ({ id: 1 }) });
    const vikunja = createVikunja({ url: "https://tasks.test", token: TOKEN, fetch: api.fetch });
    await vikunja.info();
    await vikunja.getTask(1);
    expect(api.calls.map((call) => call.headers.get("authorization"))).toEqual([null, `Bearer ${TOKEN}`]);
  });

  it("keeps a sub-path install in the request URL", async () => {
    const urls: string[] = [];
    await client(async (input) => {
      urls.push(String(input));
      return Response.json({ version: "v2.6.0" });
    }).info();
    expect(urls).toEqual(["https://tasks.test/sub/api/v1/info"]);
  });

  it("never follows redirects, so the token stays on the configured host", async () => {
    let redirect: RequestRedirect | undefined;
    const vikunja = client(async (_, init) => {
      redirect = init?.redirect;
      return new Response(null, { status: 301, headers: { location: "https://evil.test/api/v1/tasks/1" } });
    });
    await expect(vikunja.getTask(1)).rejects.toThrow(/redirected to https:\/\/evil\.test/);
    expect(redirect).toBe("manual");
  });

  it("warns that a failed write may have been applied, but not for reads", async () => {
    const vikunja = client(async () => {
      throw new TypeError("fetch failed", { cause: new Error("ECONNRESET") });
    });
    await expect(vikunja.addComment(1, "hi")).rejects.toThrow(/ECONNRESET.*read the task before retrying/);
    await expect(vikunja.getTask(1)).rejects.toThrow(/^Could not reach Vikunja at https:\/\/tasks\.test\/sub \(ECONNRESET\)\.$/);
  });

  it("explains HTTPS sent to a plain-HTTP server", async () => {
    const tls = Object.assign(new Error("ssl3_get_record:wrong version number"), { code: "ERR_SSL_WRONG_VERSION_NUMBER" });
    const vikunja = client(async () => {
      throw new TypeError("fetch failed", { cause: tls });
    });
    await expect(vikunja.info()).rejects.toThrow(/start the URL with http:\/\//);
  });

  it("explains a non-JSON answer, such as a web page at the wrong URL", async () => {
    const vikunja = client(async () => new Response("<html></html>", { headers: { "content-type": "text/html" } }));
    await expect(vikunja.info()).rejects.toThrow(/Is https:\/\/tasks\.test\/sub a Vikunja instance\?/);
  });

  it("includes Vikunja's own message for other errors", async () => {
    const vikunja = client(async () => Response.json({ code: 4002, message: "This task does not exist" }, { status: 404 }));
    await expect(vikunja.getTask(9)).rejects.toThrow("GET /tasks/9 (HTTP 404: This task does not exist)");
  });
});
