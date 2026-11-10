// Appels à l'API Higgsfield (https://docs.higgsfield.ai). Compte API séparé de l'abonnement higgsfield.ai,
// facturé en dollars à l'image. La clé vient du coffre des fonctions : HIGGSFIELD_API_KEY, au format « id:secret ».
export const HF = "https://api.higgsfield.ai";

export class HfError extends Error {}

export function hfKey(): string | undefined {
  const k = (Deno.env.get("HIGGSFIELD_API_KEY") || "").trim();
  const s = (Deno.env.get("HIGGSFIELD_API_SECRET") || "").trim();
  // La console Higgsfield donne souvent la clé complète « identifiant:secret » d'un bloc :
  // on la prend où qu'elle ait été collée.
  if (k.includes(":")) return k;
  if (s.includes(":")) return s;
  if (k && s) return `${k}:${s}`;
  return k || s || undefined;
}

/** Forme de la clé, sans la révéler : aide à repérer une inversion identifiant/secret. */
export function keyShape(): string {
  const k = (Deno.env.get("HIGGSFIELD_API_KEY") || "").trim();
  const s = (Deno.env.get("HIGGSFIELD_API_SECRET") || "").trim();
  return `identifiant ${k.length} car.${k.includes(":") ? " avec « : »" : ""}, secret ${s ? s.length + " car." : "absent"}${s.includes(":") ? " avec « : »" : ""}`;
}

async function call(method: "GET" | "POST", url: string, body?: unknown, idem?: string): Promise<any> {
  const key = hfKey();
  if (!key) throw new HfError("La clé Higgsfield API n'est pas encore enregistrée.");
  const headers: Record<string, string> = { Authorization: `Key ${key}`, Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (idem) headers["Idempotency-Key"] = idem;
  const res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non JSON */ }
  if (!res.ok) {
    const d = json?.detail ?? json?.error ?? json?.message;
    const msg = typeof d === "string" ? d : d ? JSON.stringify(d).slice(0, 300) : text.slice(0, 300) || `Erreur ${res.status}`;
    if (res.status === 401) throw new HfError(`Higgsfield refuse la clé API (401 : ${msg}) [${keyShape()}].`);
    if (res.status === 403) throw new HfError(`Higgsfield refuse la demande (403 : ${msg}). Solde API ou accès au modèle à vérifier.`);
    if (res.status === 402) throw new HfError("Solde Higgsfield API insuffisant : rechargez le compte API.");
    throw new HfError(`Higgsfield : ${msg}`);
  }
  return json;
}

/** Lance une image Marketing Studio. Renvoie l'identifiant de la demande. */
export async function submitImage(p: { prompt: string; images: string[]; aspect: string; idem: string }): Promise<string> {
  const r = await call("POST", `${HF}/marketing-studio/image`, {
    prompt: p.prompt,
    image_urls: p.images.slice(0, 16),
    aspect_ratio: p.aspect,
    resolution: "2k",
    quality: "high",
  }, p.idem);
  const id = r?.request_id || r?.id;
  if (!id) throw new HfError("Higgsfield n'a pas renvoyé d'identifiant de demande.");
  return id;
}

/** État d'une demande : pending, done (avec l'adresse de l'image) ou error. */
export async function status(id: string): Promise<{ state: "pending" | "done" | "error"; url?: string; error?: string }> {
  const r = await call("GET", `${HF}/requests/${id}/status`);
  const s = String(r?.status || "").toLowerCase();
  if (s === "completed") {
    const url = r?.images?.[0]?.url || r?.image?.url || r?.output?.[0]?.url;
    return url ? { state: "done", url } : { state: "error", error: "Image terminée mais introuvable." };
  }
  if (s === "nsfw") return { state: "error", error: "Image refusée par la modération Higgsfield." };
  if (s === "failed" || s === "canceled") {
    const e = r?.error;
    return { state: "error", error: `Higgsfield : ${typeof e === "string" ? e : e?.message || "échec de la génération"}` };
  }
  return { state: "pending" };
}
