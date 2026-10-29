// Connexion à la base Supabase du hub (projet « relai »).
// Cette clé est publique par conception : les données restent protégées par les règles d'accès (RLS),
// seuls les e-mails de l'équipe (table hub_members) peuvent lire ou écrire.
window.HUB_CONFIG = {
  url: 'https://prfqywxfuitsbhihoksh.supabase.co',
  key: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InByZnF5d3hmdWl0c2JoaWhva3NoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE2OTYzNzgsImV4cCI6MjA5NzI3MjM3OH0.YmSzL2TFyqIgxf9pT5WYgyRBPRv-BK0gaD5t-PSpXK8'
};
