// hub-music : appelée depuis le hub par un membre.
//  - status        : la musique Instagram est-elle connectée ?
//  - tt_sounds     : sons TikTok tendance autorisés pour les comptes pro (via PostFast)
//  - ig_audio      : recherche dans la bibliothèque musicale Instagram (API Audio de Meta)
//  - ig_connect    : enregistre un jeton Facebook Login (avec instagram_basic + instagram_content_publish)
//  - ig_disconnect : retire ce jeton
import { createClient } from "jsr:@supabase/supabase-js@2";
import * as PFX from "../_shared/postfast.ts";
import { APP_ID, fget, IgmError, pickToken, searchAudio } from "../_shared/igmusic.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

const GENRES = ["POP", "HIP_HOP/RAP", "ELECTRONIC", "ROCK", "JAZZ"];
const RANGES = ["1DAY", "7DAY", "30DAY", "90DAY"];

async function tokens() {
  const r = await admin.from("hub_tokens").select("*").in("net", ["igm", "igm_page"]);
  return Object.fromEntries((r.data || []).map((x: any) => [x.net, x]));
}

async function connect(token: string) {
  const secret = Deno.env.get("META_APP_SECRET");
  if (!secret) throw new IgmError("La clé secrète de l'appli Meta (META_APP_SECRET) n'est pas encore enregistrée dans Supabase.");
  // 1. Jeton longue durée (60 jours)
  const ll = await fget("/oauth/access_token", { grant_type: "fb_exchange_token", client_id: APP_ID, client_secret: secret, fb_exchange_token: token });
  const user = ll.access_token as string;
  const expires = new Date(Date.now() + (ll.expires_in || 60 * 86400) * 1000).toISOString();
  // 2. Autorisations accordées
  const perms = await fget("/me/permissions", { access_token: user });
  const granted = (perms.data || []).filter((p: any) => p.status === "granted").map((p: any) => p.permission);
  const missing = ["instagram_basic", "instagram_content_publish", "pages_show_list"].filter((p) => !granted.includes(p));
  if (missing.length) throw new IgmError("Il manque ces autorisations dans le jeton : " + missing.join(", ") + ". Cochez-les puis regénérez le jeton.");
  // 3. Page reliée au compte Instagram
  const pages = await fget("/me/accounts", { fields: "id,name,access_token,instagram_business_account{id,username}", limit: "50", access_token: user });
  const withIg = (pages.data || []).filter((p: any) => p.instagram_business_account?.id);
  if (!withIg.length) throw new IgmError("Aucune Page Facebook reliée à un compte Instagram professionnel n'a été trouvée avec ce jeton. Au moment de générer le jeton, cochez bien la Page et le compte Instagram.");
  const page = withIg.find((p: any) => /select/i.test(p.instagram_business_account.username || "")) || withIg[0];
  const ig = page.instagram_business_account;
  // 4. Essai de la bibliothèque musicale
  let tested = true;
  try { await searchAudio(user, ig.id); } catch (_e) { tested = false; }
  const now = new Date().toISOString();
  const name = "@" + (ig.username || ig.id);
  let r = await admin.from("hub_tokens").upsert([
    { net: "igm", access_token: user, account_id: ig.id, account_name: name, expires_at: expires, refreshed_at: now, updated_at: now },
    { net: "igm_page", access_token: page.access_token, account_id: ig.id, account_name: page.name, expires_at: null, refreshed_at: now, updated_at: now },
  ]);
  if (r.error) throw r.error;
  r = await admin.from("hub_connections").upsert({ net: "igm", via: "meta", account_id: ig.id, account_name: name, connected_at: now, expires_at: expires, last_error: tested ? null : "Connecté, mais la bibliothèque musicale ne répond pas encore pour ce compte.", updated_at: now });
  if (r.error) throw r.error;
  return { account: name, expires_at: expires, music: tested };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    const { data: u } = await admin.auth.getUser(jwt);
    const email = u?.user?.email?.toLowerCase();
    if (!email) return json({ error: "Session expirée, reconnectez-vous." }, 401);
    const m = await admin.from("hub_members").select("email").eq("email", email).maybeSingle();
    if (!m.data) return json({ error: "Ce compte ne fait pas partie de l'équipe du hub." }, 403);
    const body = await req.json().catch(() => ({}));

    if (body.action === "tt_sounds") {
      const c = await admin.from("hub_connections").select("account_id").eq("net", "tt").eq("via", "postfast").maybeSingle();
      if (!c.data) return json({ error: "TikTok n'est pas encore connecté dans PostFast." }, 400);
      const q = new URLSearchParams({ countryCode: "FR" });
      if (GENRES.includes(body.genre)) q.set("genre", body.genre);
      if (RANGES.includes(body.range)) q.set("dateRange", body.range);
      const list = PFX.list(await PFX.pf("GET", `/social-media/${c.data.account_id}/tiktok-sounds?${q}`));
      return json({
        sounds: list.map((s: any) => ({ id: String(s.musicSoundId), title: s.name, artist: s.artist || "", duration: s.duration || null, cover: s.thumbnailUrl || null, preview: s.previewUrl || null, genres: s.genres || [] })),
      });
    }

    if (body.action === "ig_audio") {
      const t = await tokens();
      const tok = pickToken(t);
      if (!tok) return json({ error: "La musique Instagram n'est pas encore connectée." }, 400);
      return json({ sounds: await searchAudio(tok, t.igm?.account_id || t.igm_page?.account_id, String(body.q || "").trim() || undefined) });
    }

    if (body.action === "ig_connect") {
      const token = String(body.token || "").trim();
      if (token.length < 20) return json({ error: "Collez le jeton complet." }, 400);
      return json(await connect(token));
    }

    if (body.action === "ig_disconnect") {
      await admin.from("hub_tokens").delete().in("net", ["igm", "igm_page"]);
      await admin.from("hub_connections").delete().eq("net", "igm");
      return json({ ok: true });
    }

    return json({ error: "Action inconnue." }, 400);
  } catch (e) {
    const msg = e instanceof IgmError || e instanceof PFX.PfError ? e.message : "Erreur inattendue : " + (e as Error).message;
    return json({ error: msg }, 400);
  }
});
