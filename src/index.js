import { BattleSession } from "./battle_session.js";
export { BattleSession };

function getCookie(request, name) {
  const header = request.headers.get("Cookie") || "";
  const match = header.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return match ? match[1] : null;
}

export default {
  async fetch(request, env) {
    let sid = getCookie(request, "sid");
    let setCookie = null;
    if (!sid) {
      sid = crypto.randomUUID();
      // No Secure flag: some feature-phone browsers proxy through http
      // internally even when the address bar shows https.
      setCookie = `sid=${sid}; Path=/; Max-Age=2592000; HttpOnly`;
    }

    const id = env.BATTLE_SESSION.idFromName(sid);
    const stub = env.BATTLE_SESSION.get(id);
    const resp = await stub.fetch(request);

    if (setCookie) {
      const headers = new Headers(resp.headers);
      headers.append("Set-Cookie", setCookie);
      return new Response(resp.body, { status: resp.status, headers });
    }
    return resp;
  },
};
