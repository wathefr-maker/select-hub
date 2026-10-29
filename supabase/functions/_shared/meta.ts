// Appels aux API Meta (Instagram avec connexion Instagram, et Pages Facebook).
export const IG = "https://graph.instagram.com/v25.0";
export const FB = "https://graph.facebook.com/v25.0";

export class MetaError extends Error {
  constructor(message: string, public code?: number) { super(message); }
}

async function call(method: "GET" | "POST", url: string, params: Record<string, string>): Promise<any> {
  let res: Response;
  if (method === "GET") {
    res = await fetch(url + "?" + new URLSearchParams(params));
  } else {
    res = await fetch(url, { method: "POST", body: new URLSearchParams(params) });
  }
  const text = await res.text();
  let json: any;
  try { json = JSON.parse(text); } catch { throw new MetaError(`Réponse illisible (${res.status})`); }
  if (!res.ok || json.error) {
    const e = json.error || {};
    throw new MetaError(e.error_user_msg || e.message || `Erreur ${res.status}`, e.code);
  }
  return json;
}
export const get = (url: string, p: Record<string, string>) => call("GET", url, p);
export const post = (url: string, p: Record<string, string>) => call("POST", url, p);

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Attend que des conteneurs Instagram soient prêts. Renvoie true si tous sont FINISHED dans le délai. */
export async function igWaitFinished(ids: string[], token: string, maxMs: number): Promise<boolean> {
  const end = Date.now() + maxMs;
  while (true) {
    const states = await Promise.all(ids.map((id) => get(`${IG}/${id}`, { fields: "status_code", access_token: token })));
    const bad = states.find((s) => s.status_code === "ERROR" || s.status_code === "EXPIRED");
    if (bad) throw new MetaError("Instagram a refusé un média (format, taille ou durée non acceptés)");
    if (states.every((s) => s.status_code === "FINISHED")) return true;
    if (Date.now() > end) return false;
    await sleep(3000);
  }
}
