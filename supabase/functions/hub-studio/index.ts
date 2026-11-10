// hub-studio : le Studio visuels du hub.
//  - start   : crée un carrousel par paire × style choisis et lance la photo 1 chez Higgsfield
//  - tick    : fait avancer les carrousels en cours (aussi lancé chaque minute par pg_cron)
//  - approve : range les photos dans Google Drive et crée un post brouillon TikTok + Pinterest
//  - refs    : liste les photos de la fiche produit, pour choisir celles envoyées à Higgsfield
//  - reject / retry / captions / status
// La photo 1 sert de référence aux photos 2 et 3 pour garder le même décor et la même tenue.
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
const MAX_JOBS_PER_START = 12;
const TIMEOUT_MIN = 25;

const publicUrl = (path: string) => `${SB_URL}/storage/v1/object/public/${BUCKET}/${path}`;
const nowIso = () => new Date().toISOString();
const aiKey = () => Deno.env.get("ANTHROPIC_API_KEY") || "";
const driveUrl = () => Deno.env.get("DRIVE_WEBHOOK_URL") || "";
const driveSecret = () => Deno.env.get("DRIVE_WEBHOOK_SECRET") || "";

/* ---------- produits ---------- */

/** Photos produit publiques de la fiche Shopify (sans le guide des tailles). */
const MAX_REFS = 8;
async function productImages(handle: string, fallback?: string | null, all = false): Promise<string[]> {
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
      if (urls.length) return all ? urls.slice(0, 12) : urls.slice(0, 2);
    }
  } catch { /* on retombe sur l'image principale */ }
  return fallback ? [fallback] : [];
}

// Photos choisies dans le hub : seulement des liens https venant de la boutique ou du stockage du hub
function cleanRefs(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  const sbHost = new URL(SB_URL).host;
  const ok = (u: string) => {
    try {
      const h = new URL(u);
      return h.protocol === "https:" && (h.host === sbHost || h.host.endsWith("shopify.com") || h.host.endsWith("selectbythibaud.com"));
    } catch { return false; }
  };
  return [...new Set(list.filter((u) => typeof u === "string" && ok(u)) as string[])].slice(0, MAX_REFS);
}

/* ---------- textes des posts ---------- */

function template(job: any) {
  const t = job.product_title;
  const brand = (t.split(" ")[0] || "sneakers").toLowerCase().replace(/[^a-z0-9]/g, "");
  const price = job.product_price ? ` · ${Number(job.product_price).toFixed(2).replace(".", ",")} €` : "";
  return {
    tt: `${t} 👟\nDispo chez Select, 2 rue de Paris à Vichy, et sur le site${price}.\n#sneakers #${brand} #vichy #sneakershop #outfit`,
    pin: `${t} – idée de tenue sneakers\n${t}, à porter avec un jean brut ou un pantalon large. Disponible chez Select by Thibaud à Vichy et en ligne.\n${job.product_url}`,
  };
}

async function captions(job: any): Promise<{ tt: string; pin: string; ai: boolean }> {
  const base = template(job);
  if (!aiKey()) return { ...base, ai: false };
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": aiKey(), "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: Deno.env.get("ANTHROPIC_MODEL") || "claude-haiku-5-5",
        max_tokens: 700,
        system:
          "Tu écris les textes des posts de Select by Thibaud, boutique de sneakers au 2 rue de Paris à Vichy (shop.selectbythibaud.com). " +
          "Ton : chaleureux, direct, sans superlatifs creux, sans emojis en excès (2 maximum). Français. " +
          "Réponds uniquement en JSON : {\"tt\": \"...\", \"pin\": \"...\"}.",
        messages: [{
          role: "user",
          content:
            `Paire : ${job.product_title}${job.product_price ? ` (${job.product_price} €)` : ""}.\n` +
            `Style du carrousel : ${job.prompt_name}.\nFiche produit : ${job.product_url}\n\n` +
            "tt = légende TikTok pour un carrousel photo : 1re ligne accrocheuse (elle sert de titre, 90 caractères max), " +
            "1 ou 2 phrases, mention « dispo en boutique à Vichy et sur le site », puis 4 hashtags pertinents. 300 caractères max.\n" +
            "pin = description Pinterest : 1re ligne = titre de l'épingle avec les mots que les gens cherchent (marque, modèle, coloris, « tenue »), " +
            "puis 2 phrases riches en mots-clés, puis l'adresse de la fiche produit seule sur la dernière ligne. 480 caractères max.",
        }],
      }),
    });
    if (!r.ok) throw new Error(await r.text());
    const out = await r.json();
    const text = (out.content || []).map((c: any) => c.text || "").join("");
    const j = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
    let pin = String(j.pin || base.pin);
    if (!pin.includes(job.product_url)) pin = `${pin}\n${job.product_url}`;
    return { tt: String(j.tt || base.tt), pin, ai: true };
  } catch (e) {
    console.warn("captions", e);
    return { ...base, ai: false };
  }
}

/* ---------- avancement d'un carrousel ---------- */

async function claim(id: string): Promise<any | null> {
  const stale = new Date(Date.now() - 2 * 60000).toISOString();
  const { data } = await admin.from("hub_studio").update({ lock_at: nowIso() })
    .eq("id", id).eq("status", "en_cours").or(`lock_at.is.null,lock_at.lt.${stale}`).select("*").maybeSingle();
  return data;
}
const save = (id: string, patch: Record<string, unknown>) =>
  admin.from("hub_studio").update({ lock_at: null, updated_at: nowIso(), ...patch }).eq("id", id);

async function store(jobId: string, n: number, url: string): Promise<string> {
  const r = await fetch(url);
  if (!r.ok) throw new HFX.HfError("Image Higgsfield introuvable au téléchargement.");
  const type = r.headers.get("content-type") || "image/png";
  const ext = type.includes("jpeg") || type.includes("jpg") ? "jpg" : type.includes("webp") ? "webp" : "png";
  const path = `studio/${jobId}/${n}-${Date.now()}.${ext}`;
  const up = await admin.storage.from(BUCKET).upload(path, await r.arrayBuffer(), { contentType: type, upsert: true, cacheControl: "31536000" });
  if (up.error) throw new Error("Stockage : " + up.error.message);
  return path;
}

async function advance(id: string, prompts: Record<string, any>) {
  const job = await claim(id);
  if (!job) return;
  try {
    const pr = prompts[job.prompt_id];
    if (!pr) throw new Error("Style introuvable.");
    if (Date.now() - new Date(job.updated_at).getTime() > TIMEOUT_MIN * 60000 && job.step > 0) {
      throw new Error("Génération trop longue : relancez.");
    }
    const reqs = { ...(job.reqs || {}) };
    let images: any[] = [...(job.images || [])];
    const idem = (n: number) => `${job.id}-${job.attempt}-${n}`;

    if (job.step === 0) {
      if (!job.ref_images?.length) throw new Error("Aucune photo produit trouvée sur la fiche Shopify.");
      reqs["1"] = await HFX.submitImage({ prompt: pr.prompts[0], images: job.ref_images, aspect: pr.aspect, idem: idem(1) });
      await save(id, { reqs, step: 1, error: null });
      return;
    }

    if (job.step === 1) {
      const s = await HFX.status(reqs["1"]);
      if (s.state === "pending") return void (await save(id, { updated_at: job.updated_at }));
      if (s.state === "error") throw new Error(s.error);
      const path = await store(job.id, 1, s.url!);
      images = [{ n: 1, path }];
      const refs = [publicUrl(path), ...job.ref_images];
      reqs["2"] = await HFX.submitImage({ prompt: pr.prompts[1], images: refs, aspect: pr.aspect, idem: idem(2) });
      reqs["3"] = await HFX.submitImage({ prompt: pr.prompts[2], images: refs, aspect: pr.aspect, idem: idem(3) });
      await save(id, { reqs, images, step: 2 });
      return;
    }

    if (job.step === 2) {
      for (const n of [2, 3]) {
        if (images.some((i) => i.n === n)) continue;
        const s = await HFX.status(reqs[String(n)]);
        if (s.state === "error") throw new Error(s.error);
        if (s.state === "done") images.push({ n, path: await store(job.id, n, s.url!) });
      }
      images.sort((a, b) => a.n - b.n);
      if (images.length < 3) return void (await save(id, { images, updated_at: job.updated_at }));
      const c = await captions(job);
      await save(id, { images, step: 3, status: "a_revoir", captions: c });
    }
  } catch (e) {
    console.warn("advance", id, e);
    await save(id, { status: "erreur", error: (e as Error).message.slice(0, 400) });
  }
}

async function tick(onlyIds?: string[]) {
  const { data: pr } = await admin.from("hub_prompts").select("*");
  const prompts = Object.fromEntries((pr || []).map((p: any) => [p.id, p]));
  let q = admin.from("hub_studio").select("id").eq("status", "en_cours").order("created_at").limit(20);
  if (onlyIds?.length) q = q.in("id", onlyIds);
  const { data } = await q;
  await Promise.all((data || []).map((j: any) => advance(j.id, prompts)));
}

/* ---------- Google Drive (script Apps Script de l'utilisateur) ---------- */

async function toDrive(job: any, ordered: any[]): Promise<{ done: boolean; url?: string; error?: string; at?: string }> {
  if (!driveUrl()) return { done: false, error: "Google Drive n'est pas encore branché." };
  try {
    const safe = (s: string) => s.replace(/[\\/:*?"<>|]/g, "-").slice(0, 80);
    const r = await fetch(driveUrl(), {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({
        secret: driveSecret(),
        folder: safe(job.product_title),
        files: ordered.map((im, i) => ({ name: `${safe(job.product_title)} - ${safe(job.prompt_name)} - ${i + 1}.${im.path.split(".").pop()}`, url: publicUrl(im.path) })),
      }),
      redirect: "follow",
    });
    const text = await r.text();
    let j: any = null;
    try { j = JSON.parse(text); } catch { /* page HTML = script mal déployé */ }
    if (!j?.ok) return { done: false, error: j?.error || "Le script Drive n'a pas répondu correctement (vérifiez son déploiement)." };
    return { done: true, url: j.folderUrl, at: nowIso() };
  } catch (e) {
    return { done: false, error: "Drive : " + (e as Error).message };
  }
}

function orderedImages(job: any, pr: any) {
  const order: number[] = pr?.post_order?.length ? pr.post_order : [1, 2, 3];
  return order.map((n) => (job.images || []).find((i: any) => i.n === n)).filter(Boolean);
}

/* ---------- serveur ---------- */

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const body = await req.json().catch(() => ({}));

    // Passage automatique (pg_cron) : avance seulement les carrousels en cours, ne renvoie rien de sensible.
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

    if (body.action === "status") return json({ hf: !!HFX.hfKey(), ai: !!aiKey(), drive: !!driveUrl() });

    if (body.action === "tick") { await tick(body.ids); return json({ ok: true }); }

    if (body.action === "refs") {
      const { data: p } = await admin.from("products").select("handle,image_url").eq("id", Number(body.product_id)).maybeSingle();
      if (!p) return json({ error: "Paire introuvable." }, 404);
      return json({ images: await productImages(p.handle, p.image_url, true), max: MAX_REFS });
    }

    if (body.action === "start") {
      if (!HFX.hfKey()) return json({ error: "La clé Higgsfield API n'est pas encore enregistrée dans Supabase." }, 400);
      const pids: number[] = (body.product_ids || []).map(Number).filter(Boolean);
      const sids: string[] = (body.prompt_ids || []).filter(Boolean);
      if (!pids.length || !sids.length) return json({ error: "Choisissez au moins une paire et un style." }, 400);
      if (pids.length * sids.length > MAX_JOBS_PER_START) return json({ error: `${MAX_JOBS_PER_START} carrousels maximum à la fois.` }, 400);
      const { data: prods } = await admin.from("products").select("id,title,handle,image_url,min_price").in("id", pids);
      const { data: prs } = await admin.from("hub_prompts").select("id,name").in("id", sids);
      const rows: any[] = [];
      for (const p of prods || []) {
        const chosen = cleanRefs(body.refs?.[p.id]);
        const refs = chosen.length ? chosen : await productImages(p.handle, p.image_url);
        for (const s of prs || []) {
          rows.push({
            product_id: p.id, product_title: p.title, product_handle: p.handle,
            product_url: `${SHOP}/products/${p.handle}`, product_price: p.min_price,
            ref_images: refs, prompt_id: s.id, prompt_name: s.name, created_by: email,
          });
        }
      }
      const ins = await admin.from("hub_studio").insert(rows).select("id");
      if (ins.error) throw ins.error;
      const ids = (ins.data || []).map((r: any) => r.id);
      await tick(ids);
      return json({ ok: true, ids });
    }

    const { data: job } = await admin.from("hub_studio").select("*").eq("id", body.id || "").maybeSingle();
    if (!job) return json({ error: "Carrousel introuvable." }, 404);

    if (body.action === "reject") {
      await admin.from("hub_studio").update({ status: "refuse", updated_at: nowIso() }).eq("id", job.id);
      return json({ ok: true });
    }

    if (body.action === "retry") {
      if (!HFX.hfKey()) return json({ error: "La clé Higgsfield API n'est pas encore enregistrée dans Supabase." }, 400);
      await admin.from("hub_studio").update({
        status: "en_cours", step: 0, reqs: {}, images: [], error: null, lock_at: null,
        attempt: (job.attempt || 0) + 1, drive: {}, post_id: null, updated_at: nowIso(),
      }).eq("id", job.id);
      await tick([job.id]);
      return json({ ok: true });
    }

    if (body.action === "captions") {
      const c = await captions(job);
      await admin.from("hub_studio").update({ captions: c, updated_at: nowIso() }).eq("id", job.id);
      return json({ ok: true, captions: c });
    }

    if (body.action === "approve") {
      if (!["a_revoir", "valide"].includes(job.status) || (job.images || []).length < 3) return json({ error: "Ce carrousel n'est pas prêt." }, 400);
      const { data: pr } = await admin.from("hub_prompts").select("*").eq("id", job.prompt_id).maybeSingle();
      const ordered = orderedImages(job, pr);
      const caps = { ...(job.captions || {}), ...(body.captions || {}) };
      delete caps.ai;

      let postId = job.post_id;
      if (!postId) {
        postId = crypto.randomUUID();
        const ins = await admin.from("hub_posts").insert({
          id: postId,
          title: `${job.product_title} · ${job.prompt_name}`,
          networks: ["tt", "pin"],
          format: "Carrousel",
          status: "brouillon",
          captions: { tt: caps.tt || "", pin: caps.pin || "" },
          notes: `Carrousel généré dans le Studio (style ${job.prompt_name}).\nFiche produit : ${job.product_url}`,
          visuals: ordered.map((im: any, i: number) => ({ path: im.path, name: `${job.product_title} ${i + 1}` })),
          send: { ig: "direct", fb: "direct", tt: "brouillon", pin: "direct" },
          fit: { tt: "contain", pin: "cover" },
          created_by: email,
        });
        if (ins.error) throw ins.error;
      }
      const drive = job.drive?.done && !body.drive_again ? job.drive : await toDrive(job, ordered);
      await admin.from("hub_studio").update({ status: "valide", post_id: postId, captions: caps, drive, updated_at: nowIso() }).eq("id", job.id);
      return json({ ok: true, post_id: postId, drive });
    }

    return json({ error: "Action inconnue." }, 400);
  } catch (e) {
    console.error(e);
    return json({ error: (e as Error).message || "Erreur inattendue." }, 500);
  }
});
