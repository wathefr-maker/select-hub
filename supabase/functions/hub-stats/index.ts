// hub-stats : récupère les statistiques tout seul.
//  - Appelée chaque jour par pg_cron (x-cron-secret), ou depuis le hub par un membre (bouton « Actualiser les stats »).
//  - Par post publié : Instagram = chiffres officiels Meta (vues, portée, j'aime, commentaires, partages, enregistrements) ;
//    Facebook, TikTok, Pinterest = derniers chiffres relevés par PostFast.
//  - Par semaine et par réseau (hub_kpis) : abonnés, vues, interactions de la semaine en cours.
import { createClient } from "jsr:@supabase/supabase-js@2";
import * as PFX from "../_shared/postfast.ts";

const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const IGH = "https://graph.instagram.com/v25.0";
const FBH = "https://graph.facebook.com/v25.0";
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

async function g(url: string, params: Record<string, string>) {
  const r = await fetch(url + "?" + new URLSearchParams(params));
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error(j.error?.message || `Erreur ${r.status}`);
  return j;
}

/** Semaine ISO (ex. 2026-W44) et son lundi 00:00 heure de Paris (approx. UTC+1/+2). */
function isoWeek(d: Date) {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dn = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - dn);
  const y = t.getUTCFullYear();
  const w = Math.ceil(((t.getTime() - Date.UTC(y, 0, 1)) / 864e5 + 1) / 7);
  return `${y}-W${String(w).padStart(2, "0")}`;
}
function mondayUtc(d: Date) {
  const m = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  m.setUTCDate(m.getUTCDate() - ((m.getUTCDay() + 6) % 7));
  return m;
}

/** Les champs de PostFast ne sont pas documentés : on reconnaît les chiffres par leur nom. */
function mapMetric(m: any) {
  if (!m || typeof m !== "object") return null;
  const flat: Record<string, number> = {};
  const walk = (o: any, pre = "") => {
    for (const [k, v] of Object.entries(o || {})) {
      if (typeof v === "number") flat[(pre + k).toLowerCase()] = v;
      else if (v && typeof v === "object" && !Array.isArray(v)) walk(v, pre + k + ".");
    }
  };
  walk(m);
  const pick = (...words: string[]) => {
    for (const w of words) for (const [k, v] of Object.entries(flat)) if (k.includes(w)) return v;
    return null;
  };
  const out = {
    vues: pick("view", "play", "impression"),
    likes: pick("like", "reaction"),
    comm: pick("comment"),
    partages: pick("share", "repost"),
    enreg: pick("save", "saved", "bookmark"),
  };
  return Object.values(out).some((v) => v != null) ? out : null;
}

async function run() {
  const now = new Date();
  const toks = Object.fromEntries(((await admin.from("hub_tokens").select("*")).data || []).map((r: any) => [r.net, r]));
  const conns = Object.fromEntries(((await admin.from("hub_connections").select("*").eq("via", "postfast")).data || []).map((r: any) => [r.net, r]));
  const report: Record<string, unknown> = {};

  // 1. Derniers chiffres PostFast (90 jours)
  const pfMap: Record<string, any> = {};
  if (PFX.pfKey() && Object.keys(conns).length) {
    try {
      const q = new URLSearchParams({
        startDate: new Date(now.getTime() - 90 * 864e5).toISOString(),
        endDate: new Date(now.getTime() + 864e5).toISOString(),
        socialMediaIds: Object.values(conns).map((c: any) => c.account_id).join(","),
      });
      for (const p of PFX.list(await PFX.pf("GET", `/social-posts/analytics?${q}`))) pfMap[p.id] = p;
    } catch (e) { report.postfast = (e as Error).message; }
  }

  // Le jeton Instagram (connexion Instagram, 60 jours) se renouvelle ici quand il reste moins de 30 jours.
  if (toks.ig?.expires_at && new Date(toks.ig.expires_at).getTime() - now.getTime() < 30 * 864e5) {
    try {
      const r = await g("https://graph.instagram.com/refresh_access_token", { grant_type: "ig_refresh_token", access_token: toks.ig.access_token });
      const expires = new Date(now.getTime() + (r.expires_in || 5184000) * 1000).toISOString();
      await admin.from("hub_tokens").update({ access_token: r.access_token, expires_at: expires, refreshed_at: now.toISOString(), updated_at: now.toISOString() }).eq("net", "ig");
      toks.ig.access_token = r.access_token;
    } catch (e) { report.ig_refresh = (e as Error).message; }
  }

  // 2. Statistiques par post
  const igTok = toks.ig?.access_token;
  const { data: posts } = await admin.from("hub_posts").select("id,date,networks,published,stats").not("published", "is", null);
  let updated = 0;
  const weekPosts: Record<string, any[]> = {};
  const wk = isoWeek(now);
  for (const p of posts || []) {
    const pub = p.published || {};
    const stats = { ...(p.stats || {}) };
    let changed = false;
    for (const net of Object.keys(pub)) {
      const s = pub[net];
      if (!s?.done || s.draft) continue;
      const ids: string[] = s.pf_ids || (s.pf_id ? [s.pf_id] : []);
      const pfPosts = ids.map((id) => pfMap[id]).filter(Boolean);
      let row: any = null, src = "";
      if (net === "ig" && igTok) {
        const mediaId = s.id || pfPosts[0]?.platformPostId;
        if (mediaId) {
          try {
            const r = await g(`${IGH}/${mediaId}/insights`, { metric: "views,reach,likes,comments,shares,saved", access_token: igTok });
            const v = Object.fromEntries((r.data || []).map((m: any) => [m.name, m.values?.[0]?.value ?? null]));
            row = { vues: v.views, portee: v.reach, likes: v.likes, comm: v.comments, partages: v.shares, enreg: v.saved };
            src = "Instagram";
          } catch (_e) { /* story expirée, média supprimé… */ }
        }
      }
      if (!row && pfPosts.length) {
        const ms = pfPosts.map((x) => mapMetric(x.latestMetric)).filter(Boolean) as any[];
        if (ms.length) {
          row = {};
          for (const k of ["vues", "likes", "comm", "partages", "enreg"]) {
            const vals = ms.map((m) => m[k]).filter((x) => x != null);
            row[k] = vals.length ? vals.reduce((a: number, b: number) => a + b, 0) : null;
          }
          src = "PostFast";
        }
      }
      if (!row) continue;
      stats[net] = { ...(stats[net] || {}), ...Object.fromEntries(Object.entries(row).filter(([, v]) => v != null)), _auto: now.toISOString(), _src: src };
      changed = true;
      const pd = s.at ? new Date(s.at) : null;
      if (pd && isoWeek(pd) === wk) (weekPosts[net] = weekPosts[net] || []).push(stats[net]);
    }
    if (changed) {
      await admin.from("hub_posts").update({ stats }).eq("id", p.id);
      updated++;
    }
  }
  report.posts = updated;

  // 3. Chiffres de la semaine par réseau
  const kpi: Record<string, Record<string, number | null>> = {};
  const sumWeek = (net: string, f: string[]) => {
    const l = weekPosts[net] || [];
    if (!l.length) return null;
    return l.reduce((a, s) => a + f.reduce((b, k) => b + (Number(s[k]) || 0), 0), 0);
  };
  if (igTok) {
    try {
      const me = await g(`${IGH}/me`, { fields: "followers_count", access_token: igTok });
      const since = Math.floor(mondayUtc(now).getTime() / 1000), until = Math.floor(now.getTime() / 1000);
      const ins = await g(`${IGH}/me/insights`, { metric: "views,total_interactions", period: "day", metric_type: "total_value", since: String(since), until: String(until), access_token: igTok });
      const v = Object.fromEntries((ins.data || []).map((m: any) => [m.name, m.total_value?.value ?? null]));
      kpi.ig = { abonnes: me.followers_count ?? null, vues: v.views ?? null, interactions: v.total_interactions || sumWeek("ig", ["likes", "comm", "partages", "enreg"]) };
    } catch (e) { report.ig = (e as Error).message; }
  }
  const fbTok = toks.fb?.access_token || toks.igm_page?.access_token;
  const fbPage = toks.fb?.account_id || "109775074722363";
  if (fbTok) {
    try {
      const pg = await g(`${FBH}/${fbPage}`, { fields: "followers_count", access_token: fbTok });
      kpi.fb = { abonnes: pg.followers_count ?? null, vues: sumWeek("fb", ["vues"]), interactions: sumWeek("fb", ["likes", "comm", "partages", "enreg"]) };
    } catch (e) { report.fb = (e as Error).message; }
  }
  for (const net of ["tt", "pin"]) {
    const c = conns[net];
    if (!c) continue;
    let ab: number | null = null;
    try {
      const h = await PFX.pf("GET", `/social-media/${c.account_id}/follower-history`);
      const series = h.series || h.data || [];
      const last = series[series.length - 1];
      ab = h.current ?? h.currentCount ?? last?.count ?? last?.followers ?? last?.value ?? null;
    } catch (_e) { /* pas encore d'historique */ }
    kpi[net] = { abonnes: ab, vues: sumWeek(net, ["vues"]), interactions: sumWeek(net, ["likes", "comm", "partages", "enreg"]) };
  }
  for (const [net, k] of Object.entries(kpi)) {
    const vals = Object.fromEntries(Object.entries(k).filter(([, v]) => v != null));
    if (!Object.keys(vals).length) continue;
    await admin.from("hub_kpis").upsert({ week: wk, net, ...vals, updated_at: now.toISOString() }, { onConflict: "week,net" });
  }
  report.kpis = kpi;
  await admin.from("hub_settings").upsert({ key: "stats_sync", value: { at: now.toISOString(), report }, updated_at: now.toISOString() });
  return report;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
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
  }
  try {
    return json({ ok: true, report: await run() });
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
