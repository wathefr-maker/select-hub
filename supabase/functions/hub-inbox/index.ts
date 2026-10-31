// hub-inbox : fait remonter les messages et commentaires dans le hub, avec une réponse proposée par l'IA.
//  - Commentaires Instagram, Facebook, TikTok : boîte de réception PostFast.
//  - Messages privés Instagram : API Instagram (connexion Instagram, permission messages).
//  - Réponse proposée : Claude (clé ANTHROPIC_API_KEY), avec les infos boutique et le stock Shopify synchronisé.
// Appelée toutes les 10 min par pg_cron (x-cron-secret) ou depuis le hub (bouton « Relever les messages » / « Nouvelle proposition »).
import { createClient } from "jsr:@supabase/supabase-js@2";
import * as PFX from "../_shared/postfast.ts";

const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const IGH = "https://graph.instagram.com/v25.0";
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
const NETMAP: Record<string, string> = { INSTAGRAM: "ig", FACEBOOK: "fb", TIKTOK: "tt", PINTEREST: "pin" };

async function g(url: string, params: Record<string, string>) {
  const r = await fetch(url + "?" + new URLSearchParams(params));
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error(j.error?.message || `Erreur ${r.status}`);
  return j;
}
const str = (...v: any[]) => v.find((x) => typeof x === "string" && x.trim()) || "";

/* ---------- Relevé : commentaires via PostFast ---------- */
async function pfComments(conns: Record<string, any>, since: number) {
  const byAcc = Object.fromEntries(Object.entries(conns).map(([net, c]: any) => [c.account_id, net]));
  const out: any[] = [];
  const convs = PFX.list(await PFX.pf("GET", "/social-inbox/conversations?limit=50"));
  for (const c of convs.slice(0, 40)) {
    const last = Date.parse(str(c.lastActivityAt, c.lastItemAt, c.updatedAt, c.lastMessageAt)) || Date.now();
    if (last < since) continue;
    const net = byAcc[c.socialMediaId] || NETMAP[String(c.platform || "").toUpperCase()] || null;
    if (!net) continue;
    const items = PFX.list(await PFX.pf("GET", `/social-inbox/conversations/${c.id}/items`));
    for (const it of items) {
      const mine = it.isFromMe ?? it.fromMe ?? it.isOwn ?? it.outgoing ?? (String(it.direction || "").toUpperCase() === "OUTBOUND");
      if (mine) continue;
      const text = str(it.text, it.content, it.message, it.body);
      if (!text) continue;
      const at = Date.parse(str(it.createdAt, it.platformCreatedAt, it.timestamp, it.publishedAt)) || Date.now();
      if (at < since) continue;
      out.push({
        net, kind: "commentaire", source: "postfast", ext_id: "pf:" + it.id, conv_id: c.id,
        from_handle: str(it.authorUsername, it.author?.username, it.authorName, it.author?.name, it.from?.username, it.from?.name) || "Anonyme",
        text, received_at: new Date(at).toISOString(),
        context: str(c.postContent, c.post?.content, c.title, c.postCaption).slice(0, 300) || null,
      });
    }
  }
  return out;
}

/* ---------- Relevé : messages privés Instagram ---------- */
const answered: { conv: string; at: string }[] = [];
async function igDMs(tok: any, since: number) {
  // Une entrée par conversation : les messages du client arrivés depuis la dernière réponse de la boutique.
  const out: any[] = [];
  const r = await g(`${IGH}/me/conversations`, { platform: "instagram", fields: "id,updated_time,messages.limit(15){id,message,from,created_time}", limit: "25", access_token: tok.access_token });
  for (const c of r.data || []) {
    if (Date.parse(c.updated_time || "") < since) continue;
    const msgs = (c.messages?.data || []).slice().sort((a: any, b: any) => Date.parse(a.created_time) - Date.parse(b.created_time));
    const isShop = (m: any) => m.from?.id === tok.account_id || m.from?.username === "select_vichy";
    const lastShop = msgs.map((m: any) => isShop(m)).lastIndexOf(true);
    const pending = msgs.slice(lastShop + 1).filter((m: any) => !isShop(m) && m.message);
    if (!pending.length) { if (lastShop >= 0) answered.push({ conv: c.id, at: msgs[lastShop].created_time }); continue; }
    const last = pending[pending.length - 1];
    const at = Date.parse(last.created_time || "") || Date.now();
    if (at < since) continue;
    const before = msgs.slice(Math.max(0, lastShop - 2), lastShop + 1).filter((m: any) => m.message).map((m: any) => `${isShop(m) ? "Boutique" : "Client"} : ${m.message}`).join("\n");
    out.push({
      net: "ig", kind: "dm", source: "instagram", ext_id: "igdm:" + last.id, conv_id: c.id,
      from_handle: "@" + (last.from?.username || "inconnu"),
      text: pending.map((m: any) => m.message).join("\n"),
      received_at: new Date(at).toISOString(),
      context: before ? "Échange précédent :\n" + before.slice(0, 500) : null,
    });
  }
  return out;
}

/* ---------- Réponse proposée par l'IA ---------- */
async function stockFor(text: string) {
  const words = (text.toLowerCase().match(/[a-zà-ÿ0-9]{3,}/g) || [])
    .filter((w) => !["bonjour", "salut", "est", "vous", "avez", "les", "des", "une", "pour", "taille", "pointure", "dispo", "disponible", "encore", "merci", "combien", "prix", "svp", "stp", "avec", "dans", "quel", "quelle", "elle", "ils", "sont", "cette", "paire"].includes(w))
    .slice(0, 6);
  if (!words.length) return [];
  let q = admin.from("products").select("id,title,vendor,min_price,handle").eq("status", "ACTIVE");
  for (const w of words.slice(0, 3)) q = q.ilike("title", `%${w}%`);
  let { data } = await q.limit(5);
  if (!data?.length && words.length) ({ data } = await admin.from("products").select("id,title,vendor,min_price,handle").eq("status", "ACTIVE").ilike("title", `%${words[0]}%`).limit(5));
  const out = [];
  for (const p of data || []) {
    const v = await admin.from("variants").select("size,available,inventory_quantity").eq("product_id", p.id);
    const sizes = (v.data || []).filter((x: any) => x.available || (x.inventory_quantity || 0) > 0).map((x: any) => x.size).filter(Boolean);
    out.push(`${p.title} — ${p.min_price} € — ${sizes.length ? "tailles dispo : " + sizes.join(", ") : "plus de taille disponible"}`);
  }
  return out;
}

async function suggest(m: any, store: string) {
  const key = Deno.env.get("ANTHROPIC_API_KEY");
  if (!key) return null;
  const stock = await stockFor(m.text).catch(() => []);
  const where = { ig: "Instagram", fb: "Facebook", tt: "TikTok", pin: "Pinterest" }[m.net as string] || m.net;
  const prompt = `Tu réponds pour la boutique de sneakers Select by Thibaud (Vichy) sur ${where}, dans un ${m.kind === "dm" ? "message privé" : "commentaire public"}.

Infos boutique (à jour, ne rien inventer en dehors) :
${store || "(non renseignées)"}

${stock.length ? "Stock du site correspondant au message (synchronisé avec Shopify) :\n" + stock.join("\n") : "Aucun produit du site ne correspond clairement au message."}
${m.context ? "\n" + (m.kind === "dm" ? m.context : "Publication commentée : " + m.context) : ""}

Message de ${m.from_handle} :
"""${m.text}"""

Rédige UNE réponse prête à envoyer : en français, chaleureuse, courte (1 à 3 phrases), tutoiement si le client tutoie sinon vouvoiement, 1 emoji maximum. N'invente ni prix, ni taille, ni horaire, ni stock absent des infos ci-dessus : si tu ne sais pas, propose de passer en boutique ou d'écrire en message privé. Pour un commentaire public sur un prix ou une dispo, invite à passer en message privé.
Puis, sur une dernière ligne, écris exactement « Catégorie : » suivi d'un seul mot parmi : dispo, prix, horaires, reprise, autre.`;
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: "claude-haiku-5-5", max_tokens: 400, messages: [{ role: "user", content: prompt }] }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error("IA : " + (j.error?.message || r.status));
  const txt: string = (j.content || []).map((c: any) => c.text || "").join("").trim();
  const cat = (txt.match(/Catégorie\s*:\s*(dispo|prix|horaires|reprise|autre)/i)?.[1] || "autre").toLowerCase();
  const reply = txt.replace(/\n?\s*Catégorie\s*:.*$/is, "").trim();
  return { reply, type: cat };
}

async function run(opts: { regen?: string; probe?: boolean }) {
  const now = new Date();
  const report: Record<string, unknown> = {};
  const settings = Object.fromEntries(((await admin.from("hub_settings").select("*").in("key", ["store_info", "inbox_sync"])).data || []).map((r: any) => [r.key, r.value]));
  const store = settings.store_info?.text || "";

  if (opts.regen) {
    const { data: m } = await admin.from("hub_messages").select("*").eq("id", opts.regen).single();
    const s = await suggest(m, store);
    if (!s) throw new Error("La clé de l'IA (ANTHROPIC_API_KEY) n'est pas encore enregistrée dans Supabase.");
    await admin.from("hub_messages").update({ reply: s.reply, ai_at: now.toISOString() }).eq("id", m.id);
    return { reply: s.reply };
  }

  const toks = Object.fromEntries(((await admin.from("hub_tokens").select("*")).data || []).map((r: any) => [r.net, r]));
  const conns = Object.fromEntries(((await admin.from("hub_connections").select("*").eq("via", "postfast")).data || []).map((r: any) => [r.net, r]));

  if (opts.probe) {
    const out: Record<string, unknown> = {};
    try {
      const convs = await PFX.pf("GET", "/social-inbox/conversations?limit=5");
      out.convs = JSON.stringify(convs).slice(0, 2500);
      const first = PFX.list(convs)[0];
      if (first) out.items = JSON.stringify(await PFX.pf("GET", `/social-inbox/conversations/${first.id}/items`)).slice(0, 2500);
    } catch (e) { out.pf = (e as Error).message; }
    out.ai = !!Deno.env.get("ANTHROPIC_API_KEY");
    return out;
  }

  // Première fois : on remonte les 7 derniers jours, ensuite depuis le dernier relevé (avec 1 h de marge).
  const lastAt = settings.inbox_sync?.at ? Date.parse(settings.inbox_sync.at) : 0;
  const since = lastAt ? lastAt - 3600e3 : now.getTime() - 7 * 864e5;
  answered.length = 0;
  let found: any[] = [];
  if (PFX.pfKey() && Object.keys(conns).length) {
    try { found = found.concat(await pfComments(conns, since)); } catch (e) { report.comments = (e as Error).message; }
  }
  if (toks.ig) {
    try { found = found.concat(await igDMs(toks.ig, since)); } catch (e) { report.dm = (e as Error).message; }
  }
  // Nouveaux seulement
  // Messages auxquels la boutique a répondu directement dans l'appli : passés en « répondu ».
  for (const a of answered) {
    await admin.from("hub_messages").update({ status: "repondu" }).eq("conv_id", a.conv).eq("status", "a_repondre").lte("received_at", a.at);
  }
  const ids = found.map((f) => f.ext_id);
  const known = new Set(((await admin.from("hub_messages").select("ext_id").in("ext_id", ids.length ? ids : ["-"])).data || []).map((r: any) => r.ext_id));
  const fresh = found.filter((f) => !known.has(f.ext_id));
  let ai = 0;
  for (const f of fresh) {
    let s: any = null;
    try { s = await suggest(f, store); } catch (e) { report.ai = (e as Error).message; }
    if (s) ai++;
    await admin.from("hub_messages").insert({ ...f, type: s?.type || "autre", reply: s?.reply || null, ai_at: s ? now.toISOString() : null, status: "a_repondre", created_at: f.received_at });
  }
  // Messages restés sans proposition (IA pas encore branchée au moment du relevé) : on complète, 10 par passage.
  if (Deno.env.get("ANTHROPIC_API_KEY")) {
    const { data: todo } = await admin.from("hub_messages").select("*").eq("status", "a_repondre").is("reply", null).is("ai_at", null).limit(10);
    for (const m of todo || []) {
      try { const s = await suggest(m, store); if (s) { await admin.from("hub_messages").update({ reply: s.reply, type: m.type && m.type !== "autre" ? m.type : s.type, ai_at: now.toISOString() }).eq("id", m.id); ai++; } }
      catch (e) { report.ai = (e as Error).message; break; }
    }
  }
  report.new = fresh.length;
  report.ai = report.ai || ai;
  await admin.from("hub_settings").upsert({ key: "inbox_sync", value: { at: now.toISOString(), report, ai: !!Deno.env.get("ANTHROPIC_API_KEY") }, updated_at: now.toISOString() });
  return report;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const body = await req.json().catch(() => ({}));
  const secret = req.headers.get("x-cron-secret");
  if (secret) {
    const ok = await admin.rpc("hub_cron_secret_ok", { s: secret });
    if (ok.data !== true) return new Response("forbidden", { status: 403 });
  } else {
    const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    const { data: u } = await admin.auth.getUser(jwt);
    const email = u?.user?.email?.toLowerCase();
    if (!email) return json({ error: "Session expirée, reconnectez-vous." }, 401);
    const m = await admin.from("hub_members").select("email").eq("email", email).maybeSingle();
    if (!m.data) return json({ error: "Ce compte ne fait pas partie de l'équipe du hub." }, 403);
    body.probe = false;
  }
  try {
    return json({ ok: true, ...(await run({ regen: body.regen, probe: body.probe })) });
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
