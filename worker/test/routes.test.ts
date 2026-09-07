import { SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { resetData } from "./apply-schema";
import { attempts, control, resetAttempts } from "./origin";

const DOCS = {
  decision: [
    {
      summary: "Ισολογισμός Χρήσης 2024",
      kak: "5503973",
      assemblyDecisionUrl:
        "https://opendata-api.businessportal.gr/api/opendata/v1/downloadFile?key=assemblyDecision&elementId=5503973",
    },
  ],
  publication: [],
};

beforeEach(async () => {
  await control();
  await resetData();
});

describe("input validation", () => {
  it("rejects a ΓΕΜΗ number that is not a ΓΕΜΗ number before spending a request", async () => {
    await resetAttempts();
    const res = await SELF.fetch("https://wayfinder.test/api/company/not-a-number");
    expect(res.status).toBe(400);
    expect((await res.json() as any).error).toBe("bad_ar_gemi");
    expect((await attempts()).length).toBe(0);
  });

  it("rejects a search too short to be meaningful", async () => {
    await resetAttempts();
    const res = await SELF.fetch("https://wayfinder.test/api/search?q=ab");
    expect(res.status).toBe(400);
    expect((await attempts()).length).toBe(0);
  });

  it("answers health without touching GEMI", async () => {
    await resetAttempts();
    const res = await SELF.fetch("https://wayfinder.test/api/health");
    expect(res.status).toBe(200);
    expect((await attempts()).length).toBe(0);
  });
});

describe("document download", () => {
  it("refuses an elementId that is not in this company's own filings", async () => {
    await control({ body: DOCS });
    // Warm the documents list so the check has something to check against.
    await SELF.fetch("https://wayfinder.test/api/company/000000009001/documents");

    const res = await SELF.fetch("https://wayfinder.test/api/company/000000009001/document/999999");
    expect(res.status).toBe(404);
    expect((await res.json() as any).error).toBe("document_not_in_company_filings");
  });

  it("rejects a malformed elementId outright", async () => {
    const res = await SELF.fetch("https://wayfinder.test/api/company/000000009002/document/..%2Fetc");
    expect(res.status).toBe(400);
  });
});

describe("every answer is dated", () => {
  it("carries fetched_at and the ΓΕΜΗ attribution", { timeout: 20_000 }, async () => {
    await control({ body: { arGemi: "000000009100", coNameEl: "ΔΟΚΙΜΗ" } });
    let body: any;
    // The first call may be queued behind the pace; drain until it lands.
    for (let i = 0; i < 40; i++) {
      const res = await SELF.fetch("https://wayfinder.test/api/company/000000009100");
      body = await res.json();
      if (body.data) break;
      await new Promise((r) => setTimeout(r, 150));
    }
    expect(body.data).toBeTruthy();
    expect(typeof body.meta.fetched_at).toBe("number");
    expect(body.meta.attribution).toContain("ODC-BY-1.0");
  });
});
