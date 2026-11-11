-- Studio visuels : styles validés (prompts) et carrousels générés.

create table if not exists public.hub_prompts (
  id text primary key,
  name text not null,
  description text not null default '',
  prompts text[] not null,               -- 3 prompts : photo 1 (référence), photo 2, photo 3
  aspect text not null default '2:3',
  position int not null default 0,
  active boolean not null default true,
  updated_at timestamptz not null default now()
);

create table if not exists public.hub_studio (
  id text primary key default (gen_random_uuid())::text,
  product_id bigint,
  product_title text not null default '',
  product_handle text not null default '',
  product_url text not null default '',
  product_price numeric,
  ref_images text[] not null default '{}', -- photos produit Shopify utilisées en référence
  prompt_id text not null,
  prompt_name text not null default '',
  status text not null default 'en_cours'
    check (status = any (array['en_cours','a_revoir','valide','refuse','erreur'])),
  step int not null default 0,              -- 0 à lancer, 1 photo 1 en cours, 2 photos 2-3 en cours, 3 terminé
  reqs jsonb not null default '{}',         -- identifiants Higgsfield par photo
  images jsonb not null default '[]',       -- [{path, n}] dans le bucket hub-visuels
  captions jsonb not null default '{}',     -- {tt, pin}
  drive jsonb not null default '{}',        -- {done, url, error}
  post_id text,
  error text,
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists hub_studio_status_idx on public.hub_studio (status, created_at desc);

alter table public.hub_prompts enable row level security;
alter table public.hub_studio enable row level security;
create policy "membres du hub" on public.hub_prompts for all to authenticated
  using ((select hub_private.is_member())) with check ((select hub_private.is_member()));
create policy "membres du hub" on public.hub_studio for all to authenticated
  using ((select hub_private.is_member())) with check ((select hub_private.is_member()));

alter publication supabase_realtime add table public.hub_prompts, public.hub_studio;

insert into public.hub_prompts (id, name, description, prompts, aspect, position) values
('produit', 'Produit éditorial',
 'La paire seule sur fond beige, lumière de fenêtre : vue d''ensemble, détail, profil.',
 array[
  'Editorial product photo of this exact pair of sneakers. One shoe lying on its side showing the outsole, the other resting on top at a three-quarter angle, laces untied and falling loosely. Seamless warm beige paper backdrop, soft natural window light from the upper left, long diffused shadows, high angle shot, vertical 9:16 composition with the pair perfectly centered horizontally and vertically in the middle of the frame, fully visible and not cropped, even empty backdrop above and below the shoes, muted earthy color grading, subtle film grain, minimal and calm. Exact same sneaker design, colors and materials as the product references.',
  'Same photoshoot as the first reference image: same exact sneakers, same seamless warm beige paper backdrop, same soft natural window light from the upper left, same muted earthy color grading and subtle film grain. Close-up detail shot of the front of one shoe: the toe area, the stitching and the upper materials, with the sole edge visible, vertical 9:16 composition with the shoe centered in the middle of the frame, shallow depth of field, the rest of the shoe softly out of focus. Exact same design, colors and materials as the product references.',
  'Same photoshoot as the first reference image: same exact sneakers, same seamless warm beige paper backdrop, same soft natural window light from the upper left, long diffused shadow, same muted earthy color grading and subtle film grain. A single shoe standing upright in clean side profile view, showing the full silhouette, the side branding and the outsole, laces untied resting on the floor, perfectly centered horizontally and vertically in the middle of the vertical 9:16 frame, fully visible and not cropped, even empty backdrop above and below. Exact same design, colors and materials as the product references.'
 ], '9:16', 1),
('porte', 'Porté réaliste',
 'Aux pieds, jean large brut et chaussettes blanches, fond beige uni : détail talon levé, debout, assis jambes croisées.',
 array[
  'Candid on-feet fashion photo of a person wearing this exact pair of sneakers, seated with legs crossed at the ankle, feet raised slightly in the air, cropped from the knee down. Baggy wide-leg raw indigo selvedge denim jeans, dark rinse, the hem breaking naturally over the shoes with soft realistic creases, white ribbed crew socks. Background: a completely plain, solid, uniform warm beige studio backdrop, seamless infinity cove, no floor line, no horizon, no wall corner, no props, no furniture, nothing else in frame. Soft diffused natural window light from the left, gentle soft shadows. Shot on 35mm film, Kodak Portra 400, natural grain, true-to-life textures of suede, leather and denim, authentic editorial lookbook, not CGI, not overly polished. Exact same sneaker design, colors and materials as the references.',
  'Same photoshoot as the first reference image: same person, same baggy wide-leg raw indigo denim jeans, same white ribbed crew socks, same exact sneakers, same soft diffused window light. Now standing, cropped from mid-calf down, one foot stepping slightly forward at a three-quarter angle, the other flat, natural weight shift, denim stacking naturally over the shoes. Background: completely plain, solid, uniform warm beige studio backdrop, seamless infinity cove, no floor line, no horizon, no props, nothing else in frame; only a soft natural contact shadow under the shoes. Shot on 35mm film, Kodak Portra 400, natural grain, true-to-life textures, authentic candid lookbook, not CGI, not overly polished. Exact same sneaker design, colors and materials as the product references.',
  'Same photoshoot as the first reference image: same person, same baggy wide-leg raw indigo denim jeans, same white ribbed crew socks, same exact sneakers, same soft diffused window light. Close-up detail shot of one foot from a low side angle, heel slightly lifted as if mid-step, focus on the toe area, the side stripes and the outsole, sock and denim hem visible at the top of the frame, shallow depth of field. Background: completely plain, solid, uniform warm beige studio backdrop, seamless, no floor line, no props, nothing else in frame. Shot on 35mm film, Kodak Portra 400, natural grain, true-to-life suede and leather texture, authentic candid lookbook, not CGI, not overly polished. Exact same sneaker design, colors and materials as the product references.'
 ], '9:16', 2)
on conflict (id) do nothing;

-- Ordre de publication du carrousel (la photo 1 sert de référence aux deux autres,
-- mais le style porté se publie détail en premier).
alter table public.hub_prompts add column if not exists post_order int[] not null default '{1,2,3}';
update public.hub_prompts set post_order='{3,2,1}' where id='porte';
