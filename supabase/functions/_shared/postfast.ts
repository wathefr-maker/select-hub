// Appels à l'API PostFast (https://postfa.st/docs). La clé vient du coffre des fonctions : POSTFAST_API_KEY.
export const PF = "https://api.postfa.st";

export class PfError extends Error {}

export function pfKey(): string | undefined {
  return Deno.env.get("POSTFAST_API_KEY") || undefined;
}

export async function pf(method: "GET" | "POST", path: string, body?: unknown): Promise<any> {
  const key = pfKey();
  if (!key) throw new PfError("La clé PostFast n'est pas encore enregistrée.");
  const res = await fetch(PF + path, {
    method,
    headers: { "pf-api-key": key, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* réponse non JSON */ }
  if (!res.ok) {
    const msg = json?.message || json?.error || text.slice(0, 200) || `Erreur ${res.status}`;
    throw new PfError(`PostFast : ${Array.isArray(msg) ? msg.join(", ") : msg}`);
  }
  return json;
}

/** Les listes de PostFast peuvent arriver nues ou enveloppées ({data: [...]}) : on normalise. */
export const list = (r: any): any[] => Array.isArray(r) ? r : (r?.data || r?.items || r?.results || r?.socialMedia || []);

const NET_WORDS: Record<string, string[]> = {
  ig: ["instagram"], fb: ["facebook"], tt: ["tiktok"], pin: ["pinterest"],
};
/** Devine le réseau d'un compte PostFast à partir de ses champs (platform, type, provider…). */
export function netOf(acc: any): string | null {
  const s = JSON.stringify([acc.platform, acc.type, acc.provider, acc.socialMediaType, acc.network]).toLowerCase();
  for (const [net, words] of Object.entries(NET_WORDS)) if (words.some((w) => s.includes(w))) return net;
  return null;
}
export const accName = (acc: any): string =>
  acc.displayName || acc.name || acc.username || acc.pageName || acc.handle || acc.id;

export async function accounts() {
  return list(await pf("GET", "/social-media/my-social-accounts"));
}

export async function boards(socialMediaId: string) {
  return list(await pf("GET", `/social-media/${socialMediaId}/pinterest-boards`))
    .map((b: any) => ({ id: String(b.boardId || b.id), name: b.name || b.boardName || String(b.boardId || b.id) }));
}

const TYPES: Record<string, string> = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", mp4: "video/mp4", mov: "video/quicktime" };

/** Copie un fichier public (Supabase) vers PostFast et renvoie sa clé. */
export async function upload(url: string, path: string): Promise<{ key: string; type: "IMAGE" | "VIDEO" }> {
  const ext = (path.split(".").pop() || "jpg").toLowerCase();
  const contentType = TYPES[ext] || "image/jpeg";
  const r = await pf("POST", "/file/get-signed-upload-urls", { contentType, count: 1 });
  const slot = list(r)[0] || r;
  const signed = slot.signedUrl || slot.url || slot.uploadUrl;
  if (!signed || !slot.key) throw new PfError("PostFast n'a pas fourni d'adresse d'envoi pour le média.");
  const file = await fetch(url);
  if (!file.ok) throw new PfError("Média introuvable dans le hub.");
  const put = await fetch(signed, { method: "PUT", headers: { "Content-Type": contentType }, body: await file.arrayBuffer() });
  if (!put.ok) throw new PfError(`Envoi du média vers PostFast refusé (${put.status}).`);
  return { key: slot.key, type: contentType.startsWith("video") ? "VIDEO" : "IMAGE" };
}

/** Lit l'état d'un post PostFast (recherché parmi les posts du compte). */
export async function postState(pfId: string, socialMediaId: string): Promise<{ state: "done" | "error" | "pending"; url?: string | null; error?: string }> {
  const q = new URLSearchParams({ socialMediaIds: socialMediaId });
  const all = list(await pf("GET", `/social-posts?${q}`));
  const p = all.find((x: any) => x.id === pfId);
  if (!p) return { state: "pending" };
  // Champs observés : status (DRAFT, SCHEDULED, …), publishedAt, failedAt, platformPostId, lastError.
  const s = String(p.status || "").toUpperCase();
  const url = p.platformPostUrl || p.permalink || null;
  if (p.failedAt || s.includes("FAIL") || s.includes("ERROR")) {
    const le = p.lastError;
    const msg = typeof le === "string" ? le : le?.message || le?.error || (le ? JSON.stringify(le) : "");
    return { state: "error", error: msg ? `PostFast : ${msg}` : "PostFast signale un échec de publication." };
  }
  if (p.publishedAt || p.platformPostId || s === "PUBLISHED") return { state: "done", url };
  return { state: "pending" };
}
