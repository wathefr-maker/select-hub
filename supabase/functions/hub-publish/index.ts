// hub-publish : lancée toutes les 5 minutes par une tâche planifiée (pg_cron).
// Publie sur Instagram et Facebook les posts « Programmé » dont l'heure est passée (heure de Paris),
// suit chaque réseau dans hub_posts.published, et renouvelle le jeton Instagram avant expiration.
import { createClient } from "jsr:@supabase/supabase-js@2";
import { FB, get, IG, igWaitFinished, MetaError, post } from "../_shared/meta.ts";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const admin = createClient(SB_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const BUCKET = "hub-visuels";
const AUTO = ["ig", "fb"]; // réseaux publiés automatiquement pour l'instant
const MAX_ATTEMPTS = 3;

type Media = { url: string; video: boolean };
type Pub = Record<string, any>;

const publicUrl = (path: string) => `${SB_URL}/storage/v1/object/public/${BUCKET}/${path.split("/").map(encodeURIComponent).join("/")}`;
const isVideo = (path: string) => /\.(mp4|mov|quicktime)$/i.test(path);

function parisNow(): string {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("fr-FR", { timeZone: "Europe/Paris", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(new Date()).map((x) => [x.type, x.value]),
  );
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

function mediaFor(p: any, net: string): Media[] {
  const rendered: string[] = p.rendered?.[net] || [];
  const paths: string[] = rendered.length ? rendered : (p.visuals || []).map((v: any) => v.path).filter(Boolean);
  return paths.map((path) => ({ url: publicUrl(path), video: isVideo(path) }));
}

/* ---------------- Instagram ---------------- */
async function igStep(p: any, state: Pub, tok: any): Promise<Pub> {
  const t = tok.access_token, uid = tok.account_id, caption = p.captions?.ig || "";
  if (state.stage === "container") {
    if (!(await igWaitFinished([state.container], t, 20000))) return state; // encore en traitement : on repassera
    const pub = await post(`${IG}/${uid}/media_publish`, { creation_id: state.container, access_token: t });
    const info = await get(`${IG}/${pub.id}`, { fields: "permalink", access_token: t }).catch(() => ({}));
    return { done: true, id: pub.id, url: info.permalink || null, at: new Date().toISOString() };
  }
  if (state.stage === "children") {
    if (!(await igWaitFinished(state.children, t, 20000))) return state;
    const c = await post(`${IG}/${uid}/media`, { media_type: "CAROUSEL", children: state.children.join(","), caption, access_token: t });
    return igStep(p, { stage: "container", container: c.id, at: state.at }, tok);
  }
  const media = mediaFor(p, "ig");
  if (!media.length) throw new MetaError("Instagram demande au moins une photo ou une vidéo.");
  if (media.length > 10) throw new MetaError("Instagram accepte 10 médias maximum par carrousel.");
  const at = new Date().toISOString();
  if (media.length === 1) {
    const m = media[0];
    const c = await post(`${IG}/${uid}/media`, m.video
      ? { media_type: "REELS", video_url: m.url, caption, share_to_feed: "true", access_token: t }
      : { image_url: m.url, caption, access_token: t });
    return igStep(p, { stage: "container", container: c.id, at }, tok);
  }
  const children: string[] = [];
  for (const m of media) {
    const c = await post(`${IG}/${uid}/media`, m.video
      ? { media_type: "VIDEO", video_url: m.url, is_carousel_item: "true", access_token: t }
      : { image_url: m.url, is_carousel_item: "true", access_token: t });
    children.push(c.id);
  }
  return igStep(p, { stage: "children", children, at }, tok);
}

/* ---------------- Facebook (Page) ---------------- */
async function fbStep(p: any, tok: any): Promise<Pub> {
  const t = tok.access_token, page = tok.account_id, message = p.captions?.fb || "";
  const media = mediaFor(p, "fb");
  let id: string;
  const video = media.find((m) => m.video);
  if (video) {
    const r = await post(`${FB}/${page}/videos`, { file_url: video.url, description: message, access_token: t });
    id = r.id;
  } else if (media.length) {
    const params: Record<string, string> = { message, access_token: t };
    for (let i = 0; i < media.length; i++) {
      const ph = await post(`${FB}/${page}/photos`, { url: media[i].url, published: "false", access_token: t });
      params[`attached_media[${i}]`] = JSON.stringify({ media_fbid: ph.id });
    }
    id = (await post(`${FB}/${page}/feed`, params)).id;
  } else {
    if (!message.trim()) throw new MetaError("Le post Facebook n'a ni texte ni visuel.");
    id = (await post(`${FB}/${page}/feed`, { message, access_token: t })).id;
  }
  const info = await get(`${FB}/${id}`, { fields: "permalink_url", access_token: t }).catch(() => ({}));
  return { done: true, id, url: info.permalink_url || null, at: new Date().toISOString() };
}

/* ---------------- Jeton Instagram ---------------- */
async function refreshInstagram(tok: any) {
  const left = tok.expires_at ? new Date(tok.expires_at).getTime() - Date.now() : 0;
  const age = Date.now() - new Date(tok.refreshed_at).getTime();
  if (left > 30 * 86400e3 || age < 86400e3) return tok; // renouvelé quand il reste moins de 30 jours
  const r = await get("https://graph.instagram.com/refresh_access_token", { grant_type: "ig_refresh_token", access_token: tok.access_token });
  const now = new Date().toISOString();
  const expires = new Date(Date.now() + (r.expires_in || 5184000) * 1000).toISOString();
  await admin.from("hub_tokens").update({ access_token: r.access_token, expires_at: expires, refreshed_at: now, updated_at: now }).eq("net", "ig");
  await admin.from("hub_connections").update({ expires_at: expires, updated_at: now }).eq("net", "ig");
  return { ...tok, access_token: r.access_token, expires_at: expires, refreshed_at: now };
}

async function run() {
  const report: any[] = [];
  const toks = Object.fromEntries(((await admin.from("hub_tokens").select("*")).data || []).map((r: any) => [r.net, r]));
  if (toks.ig) {
    try { toks.ig = await refreshInstagram(toks.ig); }
    catch (e) { await admin.from("hub_connections").update({ last_error: "Renouvellement du jeton : " + (e as Error).message }).eq("net", "ig"); }
  }
  const now = parisNow();
  const { data: posts } = await admin.from("hub_posts").select("*").eq("status", "programme").lte("date", now.slice(0, 10));
  for (const p of posts || []) {
    if (`${p.date} ${p.time || "00:00"}` > now) continue;
    const published: Pub = { ...(p.published || {}) };
    let changed = false;
    for (const net of (p.networks || []).filter((n: string) => AUTO.includes(n))) {
      if ((p.send?.[net] || "direct") !== "direct") continue;
      const st = published[net] || {};
      if (st.done || (st.error && (st.attempts || 0) >= MAX_ATTEMPTS)) continue;
      if (!toks[net]) { published[net] = { ...st, error: "Réseau non connecté dans le hub.", attempts: MAX_ATTEMPTS, at: new Date().toISOString() }; changed = true; continue; }
      try {
        const next = net === "ig" ? await igStep(p, st.error ? {} : st, toks.ig) : await fbStep(p, toks.fb);
        published[net] = next; changed = true;
        report.push({ post: p.id, net, result: next.done ? "publié" : next.stage });
      } catch (e) {
        published[net] = { error: (e as Error).message, attempts: (st.attempts || 0) + 1, at: new Date().toISOString() };
        changed = true;
        report.push({ post: p.id, net, error: (e as Error).message });
      }
    }
    if (!changed) continue;
    const allDone = (p.networks || []).every((n: string) => published[n]?.done);
    await admin.from("hub_posts").update({ published, ...(allDone ? { status: "publie" } : {}), updated_at: new Date().toISOString() }).eq("id", p.id);
  }
  await admin.from("hub_connections").update({ last_run_at: new Date().toISOString() }).in("net", Object.keys(toks));
  return report;
}

Deno.serve(async (req) => {
  const secret = req.headers.get("x-cron-secret") || "";
  const ok = await admin.rpc("hub_cron_secret_ok", { s: secret });
  if (ok.data !== true) return new Response("forbidden", { status: 403 });
  try {
    return Response.json({ ok: true, report: await run() });
  } catch (e) {
    return Response.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
});
