// hub-postfast : appelée depuis le hub par un membre.
//  - action "sync"  : lit les comptes connectés dans PostFast, les enregistre comme connexions du hub,
//                     et renvoie les tableaux Pinterest pour le choix du tableau.
//  - action "status": dit si la clé PostFast est enregistrée.
import { createClient } from "jsr:@supabase/supabase-js@2";
import * as PFX from "../_shared/postfast.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

/** Parmi plusieurs comptes d'un même réseau, préfère celui de la boutique. */
function pick(list: any[]) {
  return list.find((a) => /select/i.test(PFX.accName(a))) || list[0];
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
    if (body.action === "status") return json({ key: !!PFX.pfKey() });
    if (!PFX.pfKey()) return json({ error: "La clé PostFast n'est pas encore enregistrée dans Supabase." }, 400);

    const accs = await PFX.accounts();
    const byNet: Record<string, any[]> = {};
    for (const a of accs) { const n = PFX.netOf(a); if (n) (byNet[n] = byNet[n] || []).push(a); }
    const now = new Date().toISOString();
    const found: Record<string, string> = {};
    for (const [net, list] of Object.entries(byNet)) {
      const a = pick(list);
      found[net] = PFX.accName(a);
      const r = await admin.from("hub_connections").upsert({
        net, via: "postfast", account_id: String(a.id), account_name: PFX.accName(a),
        connected_at: now, expires_at: null, last_error: null, updated_at: now,
      });
      if (r.error) throw r.error;
    }
    let pinBoards: { id: string; name: string }[] = [];
    if (byNet.pin) pinBoards = await PFX.boards(String(pick(byNet.pin).id));
    return json({ accounts: found, boards: pinBoards, total: accs.length });
  } catch (e) {
    return json({ error: (e as Error).message }, 400);
  }
});
