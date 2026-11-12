-- Studio vidéos : modèles validés (décor, plans, mouvements) et vidéos générées.
-- Déroulé : photos de la paire -> images des plans (à valider) -> clips animés -> montage dans le navigateur -> À planifier.

create table if not exists public.hub_video_templates (
  id text primary key,
  name text not null,
  description text not null default '',
  decor_url text not null,                   -- photo du décor de référence (bout du bureau + sol)
  plans jsonb not null,                      -- [{key,title,image_prompt,motion_prompt,refs[],after}]
  montage_order text[] not null default '{}', -- ordre des plans dans la vidéo finale
  required_photos text[] not null default '{profil,dessus,talon,semelle,boite}',
  speed numeric not null default 1.5,        -- accélération au montage
  clip_seconds int not null default 4,
  resolution text not null default '480p',
  model text not null default 'bytedance/seedance-2.0/image-to-video',
  position int not null default 0,
  active boolean not null default true,
  updated_at timestamptz not null default now()
);

create table if not exists public.hub_video_jobs (
  id text primary key default (gen_random_uuid())::text,
  template_id text not null references public.hub_video_templates(id),
  product_id bigint,
  product_title text not null default '',
  product_handle text not null default '',
  product_url text not null default '',
  product_price numeric,
  hands text not null default 'homme' check (hands = any (array['homme','femme'])),
  photos jsonb not null default '{}',        -- {profil,dessus,talon,semelle,boite} -> url
  status text not null default 'images'
    check (status = any (array['images','images_a_revoir','clips','montage','a_revoir','valide','refuse','erreur'])),
  frames jsonb not null default '{}',        -- {key: {req, path, state: pending|done|error, error}}
  clips jsonb not null default '{}',         -- {key: {req, path, state}}
  video_path text,                           -- montage final (mp4) dans le bucket hub-visuels
  captions jsonb not null default '{}',
  post_ids jsonb not null default '{}',
  error text,
  attempt int not null default 0,
  lock_at timestamptz,
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists hub_video_jobs_status_idx on public.hub_video_jobs (status, created_at desc);

alter table public.hub_video_templates enable row level security;
alter table public.hub_video_jobs enable row level security;
create policy "membres du hub" on public.hub_video_templates for all to authenticated
  using ((select hub_private.is_member())) with check ((select hub_private.is_member()));
create policy "membres du hub" on public.hub_video_jobs for all to authenticated
  using ((select hub_private.is_member())) with check ((select hub_private.is_member()));

alter publication supabase_realtime add table public.hub_video_templates, public.hub_video_jobs;

-- Modèle « Unboxing boutique », validé le 12 novembre 2026 sur la adidas BW Army.
-- {HANDS} est remplacé par la description des mains (homme ou femme avec vernis).
-- refs : decor, profil, dessus, talon, semelle, boite, ou frame:<key> (image d'un plan déjà générée).
-- after : le plan attend l'image de ce plan pour garder la même main.
insert into public.hub_video_templates (id, name, description, decor_url, plans, montage_order, position) values
('unboxing', 'Unboxing boutique',
 'Bout du bureau en bois et sol clair. Ouverture de la boîte, puis la paire en main : profil, matière, dessus, talon. 5 plans, environ 12 s.',
 'https://d2ol7oe51mr4n9.cloudfront.net/user_367znLoT6rdW2rNXvKqMuAMtwiY/cc47e193-f8a0-4a3c-8d96-5f3ec45be516.png',
 $json$[
  {"key":"profil","title":"Profil en main","refs":["decor","profil","dessus","semelle"],
   "image_prompt":"Use the first reference image as the exact background: same oak wooden counter with the same straight diagonal front edge, same light grey concrete floor above it, same soft daylight, background slightly out of focus. Nothing else in the background, no shoe box. {HANDS} holds one sneaker in clean side profile above the counter, outer side facing the camera, the sole fully visible. The sneaker is exactly the one from the product references: same colors, materials, logos and sole. Vertical 9:16 natural iPhone photo, shallow depth of field, true-to-life colors, subtle grain, real photo, not CGI. No text, no captions, no watermark.",
   "motion_prompt":"Handheld smartphone shot. The hand slowly rotates the sneaker about 20 degrees toward the camera, showing its side and sole. Fingers stay natural and still on the shoe. Background stays blurred. Realistic, natural daylight, no text."},
  {"key":"ouverture","title":"Ouverture de la boîte","refs":["decor","boite","frame:profil","profil"],"after":"profil",
   "image_prompt":"Use the first reference image as the exact background: same oak wooden counter with the same straight diagonal front edge, same light grey concrete floor above it, same soft daylight, same camera angle tilted down. Nothing else in the background, no wall. On the counter, the shoe box from the second reference sits open; the same hand and sleeve as in the third reference lifts the lid upward at the top of the box; inside, the sneakers from the product references rest in soft white tissue paper. Vertical 9:16 natural iPhone photo, true-to-life colors, subtle grain, real photo, not CGI. No text, no captions, no watermark.",
   "motion_prompt":"Handheld smartphone shot. The hand slowly lifts the lid a little higher and tilts it back, revealing the sneakers in tissue paper. The tissue paper and sneakers stay still. Slight natural camera sway. Realistic, natural daylight, no text."},
  {"key":"matiere","title":"La matière","refs":["decor","frame:profil","profil","talon"],"after":"profil",
   "image_prompt":"Extreme close-up in the same scene as the second reference image: the front and side of the same sneaker held in the same hand, the upper material texture and its stitching in sharp focus, the sole edge at the bottom. Behind, softly blurred: the same oak wooden counter edge and light grey concrete floor as the first reference image, same soft daylight. Nothing else in the background. The sneaker is exactly the one from the product references. Vertical 9:16 natural iPhone macro photo, true-to-life colors, subtle grain, real photo, not CGI. No text, no captions, no watermark.",
   "motion_prompt":"Handheld macro smartphone shot. The camera glides slowly along the upper material toward the toe, focus stays sharp on the texture. The shoe and hand stay still. Realistic, natural daylight, no text."},
  {"key":"dessus","title":"Vue de dessus","refs":["decor","frame:profil","dessus","profil"],"after":"profil",
   "image_prompt":"Top-down view of the same sneaker held in the same open hand and sleeve as in the second reference image, toe pointing toward the top of the frame, laces, tongue and upper visible. Background exactly like the first reference image: the same oak wooden counter with its straight diagonal edge and the light grey concrete floor, softly blurred, same soft daylight. Nothing else in the background. The sneaker is exactly the one from the product references. Vertical 9:16 natural iPhone photo, true-to-life colors, subtle grain, real photo, not CGI. No text, no captions, no watermark.",
   "motion_prompt":"Handheld smartphone shot, top-down. The hand slowly raises the sneaker a little toward the camera with a slight tilt, laces and tongue clearly visible. Fingers stay still. Background stays blurred. Realistic, natural daylight, no text."},
  {"key":"talon","title":"Vers le talon","refs":["decor","frame:profil","talon","semelle"],"after":"profil",
   "image_prompt":"The same hand and sleeve as in the second reference image hold the same sneaker at a three-quarter rear angle, heel, heel counter and sole in sharp focus. Background exactly like the first reference image: the same oak wooden counter with its straight diagonal edge and the light grey concrete floor above, softly blurred, same soft daylight. No shoe box, no wall, nothing else in the background. The sneaker is exactly the one from the product references: same colors and materials. Vertical 9:16 natural iPhone photo, shallow depth of field, true-to-life colors, subtle grain, real photo, not CGI. No text, no captions, no watermark.",
   "motion_prompt":"Handheld smartphone shot. The hand slowly turns the sneaker to show the heel and sole, a smooth quarter turn. Fingers stay natural. Background stays blurred. Realistic, natural daylight, no text."}
 ]$json$::jsonb, '{ouverture,profil,matiere,dessus,talon}', 0)
on conflict (id) do nothing;
