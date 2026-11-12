// hub-video : les vidéos IA du Studio (unboxing en boutique, filmé à la main).
//  1. start       : crée la vidéo avec les photos de la paire et le choix des mains, lance l'image du plan « profil »
//  2. tick        : fait avancer les images puis les clips (aussi lancé chaque minute par pg_cron)
//     Les autres plans partent quand l'image « profil » est prête : elle sert de référence pour garder la même main.
//  3. redo_frame  : refait une image de plan ; launch : lance les clips vidéo (Seedance) à partir des images validées
//  4. redo_clip   : refait un clip ; set_video : le hub a monté la vidéo dans le navigateur et l'a déposée
//  5. approve     : crée le brouillon TikTok dans « À planifier » ; toplan : le recrée s'il a été supprimé
//  reject / retry / photos (photos de la fiche produit)
import { createClient } from "jsr:@supabase/supabase-js@2";
import * as HFX from "../_shared/higgsfield.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const admin = createClient(SB_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const BUCKET = "hub-visuels";
const SHOP = "https://shop.selectbythibaud.com";
const TIMEOUT_MIN = 30;
const ASPECT = "9:16";

const publicUrl = (path: string) => `${SB_URL}/storage/v1/object/public/${BUCKET}/${path}`;
const nowIso = () => new Date().toISOString();

const HANDS: Record<string, (color: string) => string> = {
  homme: () =>
    "A man's hand (natural skin, short clean nails, no rings, no watch, plain charcoal grey sweatshirt sleeve)",
  femme: (c) =>
    `A woman's hand (natural skin, neat medium-length nails with glossy ${c} nail polish matching the main color of the sneakers, no rings, no watch, plain cream knit sweater sleeve)`,
};

/* ---------- photos ---------- */

async function productImages(handle: string, fallback?: string | null): Promise<string[]> {
  try {
    const r = await fetch(`${SHOP}/products/${encodeURIComponent(handle)}.js`, { headers: { Accept: "application/json" } });
    if (r.ok) {
      const p = await r.json();
      const media: any[] = Array.isArray(p.media) ? p.media : [];
      let urls = media
        .filter((m) => (m.media_type || "image") === "image" && !/guide|taille|size/i.test(m.alt || ""))
        .map((m) => m.src || m.preview_image?.src)
        .filter(Boolean);
      if (!urls.length && Array.isArray(p.images)) urls = p.images;
      urls = urls.map((u: string) => (u.startsWith("//") ? "https:" + u : u));
      if (urls.length) return urls.slice(0, 12);
    }
  } catch { /* image principale */ }
  return fallback ? [fallback] : [];
}

function okUrl(u: unknown): u is string {
  if (typeof u !== "string") return false;
  try {
    const h = new URL(u);
    return h.protocol === "https:" && (h.host === new URL(SB_URL).host || h.host.endsWith("shopify.com") || h.host.endsWith("selectbythibaud.com"));
  } catch { return false; }
}

/** Couleur principale de la paire, pour le vernis : tirée du titre, sinon une teinte neutre. */
function mainColor(title: string): string {
  const t = title.toLowerCase();
  const map: [RegExp, string][] = [
    [/noir|black/, "black"], [/blanc|white/, "soft white"], [/rouge|red/, "red"], [/bleu|blue|navy|marine/, "navy blue"],
    [/vert|green|army|kaki|khaki|olive/, "olive green"], [/rose|pink/, "pink"], [/beige|cream|crème|sand|sable/, "beige"],
    [/gris|grey|gray/, "grey"], [/marron|brown|choco|mocha/, "brown"], [/jaune|yellow/, "yellow"], [/orange/, "orange"],
    [/violet|purple|lilas/, "lilac"],
  ];
  for (const [re, c] of map) if (re.test(t)) return c;
  return "nude beige";
}

/* ---------- avancement ---------- */

async function claim(id: string): Promise<any | null> {
  const stale = new Date(Date.now() - 2 * 60000).toISOString();
  const { data } = await admin.from("hub_video_jobs").update({ lock_at: nowIso() })
    .eq("id", id).in("status", ["images", "clips"]).or(`lock_at.is.null,lock_at.lt.${stale}`).select("*").maybeSingle();
  return data;
}
const save = (id: string, patch: Record<string, unknown>) =>
  admin.from("hub_video_jobs").update({ lock_at: null, updated_at: nowIso(), ...patch }).eq("id", id);

async function store(path: string, url: string): Promise<string> {
  const r = await fetch(url);
  if (!r.ok) throw new HFX.HfError("Fichier Higgsfield introuvable au téléchargement.");
  const type = r.headers.get("content-type") || "application/octet-stream";
  const ext = type.includes("mp4") ? "mp4" : type.includes("jpeg") || type.includes("jpg") ? "jpg" : type.includes("webp") ? "webp" : type.startsWith("video") ? "mp4" : "png";
  const full = `${path}-${Date.now()}.${ext}`;
  const up = await admin.storage.from(BUCKET).upload(full, await r.arrayBuffer(), { contentType: type, upsert: true, cacheControl: "31536000" });
  if (up.error) throw new Error("Stockage : " + up.error.message);
  return full;
}

function refsFor(plan: any, job: any, tpl: any): string[] {
  const out: string[] = [];
  for (const r of plan.refs || []) {
    if (r === "decor") out.push(tpl.decor_url);
    else if (r.startsWith("frame:")) {
      const f = job.frames?.[r.slice(6)];
      if (f?.path) out.push(publicUrl(f.path));
    } else if (job.photos?.[r]) out.push(job.photos[r]);
  }
  return [...new Set(out)];
}

function imagePrompt(plan: any, job: any): string {
  const hands = (HANDS[job.hands] || HANDS.homme)(mainColor(job.product_title));
  return String(plan.image_prompt).replaceAll("{HANDS}", hands);
}

const late = (x: any) => x?.at && Date.now() - new Date(x.at).getTime() > TIMEOUT_MIN * 60000;

async function advance(id: string, tpls: Record<string, any>) {
  const job = await claim(id);
  if (!job) return;
  try {
    const tpl = tpls[job.template_id];
    if (!tpl) throw new Error("Modèle de vidéo introuvable.");
    const plans: any[] = tpl.plans || [];

    if (job.status === "images") {
      const frames: Record<string, any> = { ...(job.frames || {}) };
      for (const plan of plans) {
        const f = { ...(frames[plan.key] || {}) };
        if (f.state === "done") continue;
        if (f.req) {
          if (late(f)) { frames[plan.key] = { ...f, req: null, state: "error", error: "Trop long : refaites ce plan." }; continue; }
          const s = await HFX.status(f.req);
          if (s.state === "error") frames[plan.key] = { ...f, req: null, state: "error", error: s.error };
          else if (s.state === "done") frames[plan.key] = { n: f.n, state: "done", path: await store(`video/${job.id}/plan-${plan.key}`, s.url!) };
          continue;
        }
        if (f.state === "error") continue;
        // Les plans qui dépendent d'un autre attendent son image
        if (plan.after && frames[plan.after]?.state !== "done") continue;
        const n = (f.n || 0) + 1;
        const req = await HFX.submitImage({
          prompt: imagePrompt(plan, { ...job, frames }), images: refsFor(plan, { ...job, frames }, tpl), aspect: ASPECT,
          idem: `${job.id}-${plan.key}-img-${n}`,
        });
        frames[plan.key] = { n, req, state: "pending", at: nowIso() };
      }
      const settled = plans.every((p) => ["done", "error"].includes(frames[p.key]?.state));
      // Une image en échec bloque les plans qui en dépendent : on rend la main pour qu'elle soit refaite
      const blocked = plans.every((p) => {
        const s = frames[p.key]?.state;
        return s === "done" || s === "error" || (p.after && frames[p.after]?.state === "error" && !frames[p.key]?.req);
      });
      await save(id, { frames, status: settled || blocked ? "images_a_revoir" : "images", error: null });
      return;
    }

    if (job.status === "clips") {
      const clips: Record<string, any> = { ...(job.clips || {}) };
      let failed = "";
      for (const plan of plans) {
        const c = { ...(clips[plan.key] || {}) };
        if (c.state === "done") continue;
        if (c.req) {
          if (late(c)) { clips[plan.key] = { ...c, req: null, state: "error", error: "Trop long : refaites ce clip." }; failed ||= plan.title; continue; }
          const s = await HFX.status(c.req);
          if (s.state === "error") { clips[plan.key] = { ...c, req: null, state: "error", error: s.error }; failed ||= plan.title; }
          else if (s.state === "done") clips[plan.key] = { n: c.n, state: "done", path: await store(`video/${job.id}/clip-${plan.key}`, s.url!) };
          continue;
        }
        if (c.state === "error") { failed ||= plan.title; continue; }
        const frame = job.frames?.[plan.key];
        if (!frame?.path) throw new Error(`L'image du plan « ${plan.title} » manque.`);
        const n = (c.n || 0) + 1;
        const req = await HFX.submitVideo({
          model: tpl.model, image: publicUrl(frame.path), prompt: plan.motion_prompt,
          duration: tpl.clip_seconds || 4, resolution: tpl.resolution || "480p", aspect: ASPECT,
          idem: `${job.id}-${plan.key}-vid-${n}`,
        });
        clips[plan.key] = { n, req, state: "pending", at: nowIso() };
      }
      const allDone = plans.every((p) => clips[p.key]?.state === "done");
      const settled = plans.every((p) => ["done", "error"].includes(clips[p.key]?.state));
      await save(id, {
        clips,
        status: allDone ? "montage" : settled ? "erreur" : "clips",
        error: settled && !allDone ? `Le clip « ${failed} » a échoué : refaites-le.` : null,
      });
    }
  } catch (e) {
    console.warn("advance", id, e);
    await save(id, { status: "erreur", error: (e as Error).message.slice(0, 400) });
  }
}

async function tick(onlyIds?: string[]) {
  const { data: t } = await admin.from("hub_video_templates").select("*");
  const tpls = Object.fromEntries((t || []).map((x: any) => [x.id, x]));
  let q = admin.from("hub_video_jobs").select("id").in("status", ["images", "clips"]).order("created_at").limit(10);
  if (onlyIds?.length) q = q.in("id", onlyIds);
  const { data } = await q;
  await Promise.all((data || []).map((j: any) => advance(j.id, tpls)));
}

/* ---------- brouillon ---------- */

function caption(job: any): string {
  const t = job.product_title;
  const brand = (t.split(" ")[0] || "sneakers").toLowerCase().replace(/[^a-z0-9]/g, "");
  const price = job.product_price ? ` · ${Number(job.product_price).toFixed(2).replace(".", ",")} €` : "";
  return `Unboxing ${t} 📦\nDispo chez Select, 2 rue de Paris à Vichy, et sur le site${price}.\n#sneakers #${brand} #unboxing #vichy #sneakershop`;
}

async function ensurePost(job: any, caps: any, email: string): Promise<any> {
  const ids: any = { ...(job.post_ids || {}) };
  if (ids.tt) {
    const { data } = await admin.from("hub_posts").select("id").eq("id", ids.tt).maybeSingle();
    if (!data) delete ids.tt;
  }
  if (!ids.tt) {
    ids.tt = crypto.randomUUID();
    const ins = await admin.from("hub_posts").insert({
      id: ids.tt, title: `${job.product_title} · vidéo unboxing`, networks: ["tt"], format: "Vidéo", status: "brouillon",
      captions: { tt: caps.tt || caption(job) },
      notes: `Vidéo IA du Studio (unboxing).\nFiche produit : ${job.product_url}\nAjoutez un son dans l'appli TikTok.`,
      visuals: [{ path: job.video_path, name: `${job.product_title} unboxing` }],
      formats: { tt: "video" }, send: { tt: "brouillon" }, created_by: email,
    });
    if (ins.error) throw ins.error;
  }
  return ids;
}

/* ---------- serveur ---------- */

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const body = await req.json().catch(() => ({}));

    if (body.action === "tick" && !body.ids) {
      if (HFX.hfKey()) await tick();
      return json({ ok: true });
    }

    const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    const { data: u } = await admin.auth.getUser(jwt);
    const email = u?.user?.email?.toLowerCase();
    if (!email) return json({ error: "Session expirée, reconnectez-vous." }, 401);
    const m = await admin.from("hub_members").select("email").eq("email", email).maybeSingle();
    if (!m.data) return json({ error: "Ce compte ne fait pas partie de l'équipe du hub." }, 403);

    if (body.action === "tick") { await tick(body.ids); return json({ ok: true }); }

    if (body.action === "photos") {
      const { data: p } = await admin.from("products").select("handle,image_url").eq("id", Number(body.product_id)).maybeSingle();
      if (!p) return json({ error: "Paire introuvable." }, 404);
      return json({ images: await productImages(p.handle, p.image_url) });
    }

    if (body.action === "start") {
      if (!HFX.hfKey()) return json({ error: "La clé Higgsfield API n'est pas encore enregistrée dans Supabase." }, 400);
      const { data: tpl } = await admin.from("hub_video_templates").select("*").eq("id", body.template_id || "unboxing").maybeSingle();
      if (!tpl) return json({ error: "Modèle de vidéo introuvable." }, 404);
      const { data: p } = await admin.from("products").select("id,title,handle,min_price").eq("id", Number(body.product_id)).maybeSingle();
      if (!p) return json({ error: "Paire introuvable." }, 404);
      const photos: Record<string, string> = {};
      for (const k of tpl.required_photos || []) {
        const url = body.photos?.[k];
        if (!okUrl(url)) return json({ error: `Photo « ${k} » manquante.` }, 400);
        photos[k] = url;
      }
      const ins = await admin.from("hub_video_jobs").insert({
        template_id: tpl.id, product_id: p.id, product_title: p.title, product_handle: p.handle,
        product_url: `${SHOP}/products/${p.handle}`, product_price: p.min_price,
        hands: body.hands === "femme" ? "femme" : "homme", photos, created_by: email,
      }).select("id").single();
      if (ins.error) throw ins.error;
      await tick([ins.data.id]);
      return json({ ok: true, id: ins.data.id });
    }

    const { data: job } = await admin.from("hub_video_jobs").select("*").eq("id", body.id || "").maybeSingle();
    if (!job) return json({ error: "Vidéo introuvable." }, 404);
    const { data: tpl } = await admin.from("hub_video_templates").select("*").eq("id", job.template_id).maybeSingle();
    const plans: any[] = tpl?.plans || [];
    const plan = plans.find((p) => p.key === body.key);

    if (body.action === "reject") {
      await admin.from("hub_video_jobs").update({ status: "refuse", lock_at: null, updated_at: nowIso() }).eq("id", job.id);
      return json({ ok: true });
    }

    if (body.action === "redo_frame") {
      if (!plan) return json({ error: "Plan inconnu." }, 400);
      if (!["images", "images_a_revoir", "erreur"].includes(job.status) || Object.keys(job.clips || {}).length && job.status === "erreur")
        return json({ error: "Les clips vidéo sont déjà lancés : refaites plutôt le clip." }, 400);
      const frames = { ...(job.frames || {}) };
      frames[plan.key] = { n: frames[plan.key]?.n || 0 }; // sans état : relancé au prochain passage
      await admin.from("hub_video_jobs").update({ frames, status: "images", error: null, lock_at: null, updated_at: nowIso() }).eq("id", job.id);
      await tick([job.id]);
      return json({ ok: true });
    }

    if (body.action === "launch") {
      if (job.status !== "images_a_revoir") return json({ error: "Les images ne sont pas prêtes." }, 400);
      if (!plans.every((p) => job.frames?.[p.key]?.state === "done")) return json({ error: "Refaites d'abord les images en échec." }, 400);
      await admin.from("hub_video_jobs").update({ status: "clips", clips: {}, error: null, lock_at: null, updated_at: nowIso() }).eq("id", job.id);
      await tick([job.id]);
      return json({ ok: true });
    }

    if (body.action === "redo_clip") {
      if (!plan) return json({ error: "Plan inconnu." }, 400);
      if (!Object.keys(job.clips || {}).length) return json({ error: "Les clips ne sont pas encore lancés." }, 400);
      const clips = { ...(job.clips || {}) };
      clips[plan.key] = { n: clips[plan.key]?.n || 0 };
      await admin.from("hub_video_jobs").update({ clips, status: "clips", video_path: null, error: null, lock_at: null, updated_at: nowIso() }).eq("id", job.id);
      await tick([job.id]);
      return json({ ok: true });
    }

    if (body.action === "retry") {
      // Reprend là où ça a coincé : les éléments en échec sont relancés, le reste est gardé
      const inClips = Object.keys(job.clips || {}).length > 0;
      const key = inClips ? "clips" : "frames";
      const cur = { ...(job[key] || {}) };
      for (const k of Object.keys(cur)) if (cur[k]?.state !== "done") cur[k] = { n: cur[k]?.n || 0 };
      await admin.from("hub_video_jobs").update({
        [key]: cur, status: inClips ? "clips" : "images", error: null, lock_at: null, attempt: (job.attempt || 0) + 1, updated_at: nowIso(),
      }).eq("id", job.id);
      await tick([job.id]);
      return json({ ok: true });
    }

    if (body.action === "set_video") {
      const path = String(body.path || "");
      if (!path.startsWith(`video/${job.id}/`) || !/\.(mp4|webm)$/.test(path)) return json({ error: "Fichier vidéo invalide." }, 400);
      if (!["montage", "a_revoir"].includes(job.status)) return json({ error: "Cette vidéo n'est pas à l'étape du montage." }, 400);
      const caps = job.captions?.tt ? job.captions : { tt: caption(job) };
      await admin.from("hub_video_jobs").update({ video_path: path, status: "a_revoir", captions: caps, updated_at: nowIso() }).eq("id", job.id);
      return json({ ok: true });
    }

    if (body.action === "approve" || body.action === "toplan") {
      if (!job.video_path) return json({ error: "La vidéo n'est pas encore montée." }, 400);
      if (body.action === "toplan" && job.status !== "valide") return json({ error: "Cette vidéo n'est pas validée." }, 400);
      const caps = { ...(job.captions || {}), ...(body.captions || {}) };
      const ids = await ensurePost(job, caps, email);
      await admin.from("hub_video_jobs").update({ status: "valide", post_ids: ids, captions: caps, updated_at: nowIso() }).eq("id", job.id);
      return json({ ok: true, post_ids: ids });
    }

    return json({ error: "Action inconnue." }, 400);
  } catch (e) {
    console.error(e);
    return json({ error: (e as Error).message || "Erreur inattendue." }, 500);
  }
});
