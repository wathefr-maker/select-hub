// hub-connect : un membre du hub colle un jeton Meta, la fonction le vérifie et le range dans le coffre.
// Appelée depuis l'appli avec la session de l'utilisateur. Le jeton ne revient jamais vers le navigateur.
import { createClient } from "jsr:@supabase/supabase-js@2";
import { FB, get, IG, MetaError } from "../_shared/meta.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});

async function save(net: string, row: { access_token: string; account_id: string; account_name: string; expires_at: string | null }) {
  const now = new Date().toISOString();
  const t = await admin.from("hub_tokens").upsert({ net, ...row, refreshed_at: now, updated_at: now });
  if (t.error) throw t.error;
  const c = await admin.from("hub_connections").upsert({
    net, account_id: row.account_id, account_name: row.account_name, connected_at: now,
    expires_at: row.expires_at, last_error: null, updated_at: now,
  });
  if (c.error) throw c.error;
}

async function connectInstagram(token: string) {
  const me = await get(`${IG}/me`, { fields: "user_id,username", access_token: token });
  // Ce point d'accès n'exige que la permission de publication : il sert de test.
  try {
    await get(`${IG}/${me.user_id}/content_publishing_limit`, { fields: "quota_usage", access_token: token });
  } catch (_e) {
    throw new MetaError("Ce jeton ne permet pas de publier. Ajoutez la permission instagram_business_content_publish puis regénérez le jeton.");
  }
  const expires = new Date(Date.now() + 60 * 86400e3).toISOString(); // jetons du tableau de bord : 60 jours
  await save("ig", { access_token: token, account_id: String(me.user_id), account_name: "@" + me.username, expires_at: expires });
  return { account: "@" + me.username, expires_at: expires };
}

async function connectFacebook(token: string, pageId?: string) {
  let pages: { id: string; name: string; access_token: string }[] = [];
  try {
    const r = await get(`${FB}/me/accounts`, { fields: "id,name,access_token", limit: "50", access_token: token });
    pages = r.data || [];
  } catch (_e) {
    // Le jeton collé est peut-être déjà un jeton de Page.
    const me = await get(`${FB}/me`, { fields: "id,name", access_token: token });
    pages = [{ id: me.id, name: me.name, access_token: token }];
  }
  if (!pages.length) throw new MetaError("Aucune Page Facebook trouvée pour ce compte. Vérifiez que vous êtes administrateur de la Page.");
  let page = pageId ? pages.find((p) => p.id === pageId) : pages.length === 1 ? pages[0] : undefined;
  if (!page) return { choose: pages.map((p) => ({ id: p.id, name: p.name })) };

  const dbg = await get(`${FB}/debug_token`, { input_token: page.access_token, access_token: page.access_token });
  const scopes: string[] = dbg.data?.scopes || [];
  if (!scopes.includes("pages_manage_posts")) {
    throw new MetaError("Il manque la permission pages_manage_posts. Ajoutez-la dans l'explorateur, puis regénérez le jeton.");
  }
  const exp = dbg.data?.expires_at;
  const expires = exp && exp > 0 ? new Date(exp * 1000).toISOString() : null; // null = n'expire pas
  await save("fb", { access_token: page.access_token, account_id: page.id, account_name: page.name, expires_at: expires });
  return { account: page.name, expires_at: expires };
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
    const net = body.net as string;
    if (body.action === "disconnect") {
      await admin.from("hub_tokens").delete().eq("net", net);
      await admin.from("hub_connections").delete().eq("net", net);
      return json({ ok: true });
    }
    const token = String(body.token || "").trim();
    if (token.length < 20) return json({ error: "Collez le jeton complet." }, 400);
    if (net === "ig") return json(await connectInstagram(token));
    if (net === "fb") return json(await connectFacebook(token, body.page_id));
    return json({ error: "Réseau non pris en charge pour l'instant." }, 400);
  } catch (e) {
    const msg = e instanceof MetaError ? e.message : "Erreur inattendue : " + (e as Error).message;
    return json({ error: msg }, 400);
  }
});
