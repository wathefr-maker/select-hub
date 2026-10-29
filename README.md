# Hub Select

Hub réseaux sociaux de **Select by Thibaud** (2 rue de Paris, Vichy) : calendrier commun, validation à deux, messages, statistiques et récap hebdo pour Instagram, Facebook, TikTok et Pinterest.

- **Appli** : https://wathefr-maker.github.io/select-hub/ (installable sur téléphone et ordinateur)
- **Données** : Supabase, projet `relai`, tables `hub_*`, bucket `hub-visuels`
- **Accès** : réservé aux e-mails de la table `hub_members` (règles RLS). La clé dans `config.js` est la clé publique du projet : elle ne donne accès à rien sans un compte membre.

## Fichiers

| Fichier | Rôle |
| --- | --- |
| `index.html` | L’appli complète (interface + logique) |
| `config.js` | Adresse et clé publique Supabase |
| `manifest.webmanifest`, `icons/` | Installation comme une appli |
| `sw.js` | Ouverture même sans réseau |

## Installer l’appli

- **iPhone** : ouvrir le lien dans Safari → Partager → « Sur l’écran d’accueil ».
- **Android / ordinateur (Chrome, Edge)** : bouton « Installer l’appli » dans la barre du hub, ou icône d’installation dans la barre d’adresse.
