/**
 * Studio Select → Google Drive
 * Range les visuels validés dans le Studio du hub dans « Select Studio / <nom de la paire> ».
 *
 * Installation (une seule fois, environ 3 minutes) :
 *  1. Ouvrir https://script.google.com avec le compte Google du Drive, « Nouveau projet ».
 *  2. Coller ce fichier à la place du contenu, remplacer SECRET par le mot de passe choisi, enregistrer.
 *  3. Déployer → Nouveau déploiement → type « Application Web ».
 *     Exécuter en tant que : Moi. Qui a accès : Tout le monde. → Déployer, autoriser l'accès au Drive.
 *  4. Copier l'URL de l'application Web (elle finit par /exec) : c'est DRIVE_WEBHOOK_URL.
 *     Le mot de passe est DRIVE_WEBHOOK_SECRET.
 */
const SECRET = 'remplacez-moi-par-un-mot-de-passe';
const ROOT = 'Select Studio';

function folderNamed(parent, name) {
  const it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : parent.createFolder(name);
}

function doPost(e) {
  const out = (o) => ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
  try {
    const body = JSON.parse(e.postData.contents);
    if (body.secret !== SECRET) return out({ ok: false, error: 'Mot de passe Drive incorrect.' });
    const root = folderNamed(DriveApp.getRootFolder(), ROOT);
    const folder = folderNamed(root, body.folder || 'Sans nom');
    (body.files || []).forEach((f) => {
      const blob = UrlFetchApp.fetch(f.url).getBlob().setName(f.name);
      const same = folder.getFilesByName(f.name);
      while (same.hasNext()) same.next().setTrashed(true);
      folder.createFile(blob);
    });
    return out({ ok: true, folderUrl: folder.getUrl() });
  } catch (err) {
    return out({ ok: false, error: String(err) });
  }
}
