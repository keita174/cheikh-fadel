"""Construit une copie de html/index.html avec un scénario de test injecté.

Plutôt que de reproduire la page dans un fichier séparé, on part du fichier
réel : le test vérifie donc exactement ce que le navigateur charge, chemins
compris.

    python scripts/test_interface.py
"""

from __future__ import annotations

import pathlib

PAGE = pathlib.Path(__file__).resolve().parent.parent / "html" / "index.html"
SORTIE = pathlib.Path(__file__).resolve().parent.parent / "html" / "_test.html"

SCENARIO = r"""
<script>
const att = (ms) => new Promise(r => setTimeout(r, ms));
let __pre = null;
function log(t) {
  window.__log.push(t);
  if (!__pre) { __pre = document.createElement('pre'); __pre.id = 'rapport';
    __pre.style.cssText = 'position:fixed;inset:0;z-index:99999;background:#fff;'
      + 'color:#000;font:12px monospace;padding:10px;overflow:auto;margin:0;white-space:pre-wrap';
    document.body.appendChild(__pre); }
  __pre.textContent = window.__log.join('\n');
}
window.addEventListener('error', e => log('ERREUR: ' + e.message + ' @' + (e.filename||'').split('/').pop() + ':' + e.lineno));
window.addEventListener('unhandledrejection', e => log('REJET: ' + (e.reason && e.reason.message ? e.reason.message : e.reason)));

(async () => {
  const $ = s => document.querySelector(s);
  const $$ = s => Array.from(document.querySelectorAll(s));

  log('1. chargement initial…');
  await att(20000);
  const D = window.DataManager, P = window.Parcours, U = window.UI;
  log('   hopitaux=' + D.hopitaux.length + ' source=' + D.sourceHopitaux);
  log('   communes en memoire=' + D.communes.length + ' totalCommunes=' + D.totalCommunes);
  log('   vue courante=' + P.vue);
  log('');
  log('2. chiffres du bandeau daccueil :');
  for (const id of ['stat-hero-etablissements','stat-hero-communes','stat-hero-urgences','stat-hero-departements']) {
    log('   ' + id + ' = ' + ($('#' + id) || {textContent:'ABSENT'}).textContent);
  }
  log('   etat="' + $('#etat-donnees').textContent + '"');
  log('');

  log('3. passage a la carte…');
  await P.aller('carte');
  await att(14000);
  log('   vue=' + P.vue + ' | carte creee=' + (!!window.MapView.carte));
  log('   accueil masque=' + $('#vue-accueil').hidden + ' | carte visible=' + !$('#vue-carte').hidden);
  log('   couches communes=' + window.MapView.couches.communes.getLayers().length);
  log('   marqueurs hopitaux=' + window.MapView.couches.hopitaux.getLayers().length);
  log('   champ de recherche deplace dans lentete=' + !!$('#slot-recherche-carte .recherche-bloc'));
  log('   taille conteneur carte=' + $('#carte').clientWidth + 'x' + $('#carte').clientHeight);
  log('   options departement=' + $('#filtre-departement').options.length);
  log('   options route-destination=' + $('#route-destination').options.length);
  log('');
  log('3bis. mise en page des panneaux flottants :');
  const panneaux = $$('.flotant').map(e => {
    const b = e.getBoundingClientRect();
    return e.className.split(' ')[1] + ' x=' + Math.round(b.x) + ' y=' + Math.round(b.y)
      + ' ' + Math.round(b.width) + 'x' + Math.round(b.height);
  });
  panneaux.forEach(p => log('   ' + p));
  log('   attributs de classe exacts = '
    + JSON.stringify($$('.flotant').map(e => e.className)));
  log('   barre de filtres rapides = ' + JSON.stringify(
    (function(){var b=$('#filtres').getBoundingClientRect();
      return {x:Math.round(b.x),y:Math.round(b.y),w:Math.round(b.width),h:Math.round(b.height)};})())
    + ' (fenetre ' + window.innerWidth + 'x' + window.innerHeight + ')');
  log('   bouton Autour de moi = ' + JSON.stringify(
    (function(){var b=$('#btn-position').getBoundingClientRect();
      return {x:Math.round(b.x),y:Math.round(b.y),w:Math.round(b.width),h:Math.round(b.height)};})()));
  log('   boutons position/zoom presents = '
    + !!$('#btn-position') + '/' + !!$('#zoom-plus') + '/' + !!$('#recentre'));
  const aide = $$('.case .note').map(e => {
    const cs = getComputedStyle(e);
    return Math.round(e.getBoundingClientRect().width) + 'px fond=' + cs.backgroundColor;
  });
  log('   textes d aide des cases (doivent rester discrets) = ' + JSON.stringify(aide));
  log('');

  log('4. filtre par departement (13) :');
  $('#filtre-departement').value = '13';
  $('#btn-rechercher').click();
  await att(2500);
  log('   compteur="' + $('#compteur-filtre').textContent + '"');
  log('   premiere ligne="' + ($('#liste-hopitaux .ligne-hopital') || {textContent:'—'}).textContent.replace(/\s+/g,' ').trim().slice(0,70) + '"');
  log('   resume sous les filtres = "' + $('#resume-filtre').textContent + '"');
  log('   filtre actif sur MapView = "' + window.MapView.filtreDepartement + '"');
  const dansFiltre = D.communes.filter(c => String(c.departement) === '13').length;
  log('   communes du 13 dans la couche = ' + dansFiltre
    + ' | compteur MapView = ' + window.MapView.compterCommunes('13'));
  const styles = { dedans: 0, dehors: 0 };
  window.MapView.couches.communes.eachLayer(l => {
    if (!l.__commune) return;
    if (String(l.__commune.departement) === '13') styles.dedans = Math.round(l.options.fillOpacity * 100) / 100;
    else if (styles.dehors === 0) styles.dehors = Math.round(l.options.fillOpacity * 100) / 100;
  });
  log('   opacite de remplissage : dans le 13 = ' + styles.dedans
    + ' | hors 13 = ' + styles.dehors + ' (doivent differer)');
  log('   cadrage centre sur = ' + JSON.stringify(
    window.MapView.carte.getCenter()).slice(0, 60));
  log('');

  log('5. barre rapide : Tous');
  $('#filtres button[data-filtre="tous"]').click();
  await att(1200);
  log('   compteur="' + $('#compteur-filtre').textContent + '"'
    + ' | lignes=' + $$('#liste-hopitaux .ligne-hopital').length
    + ' | marqueurs=' + window.MapView.couches.hopitaux.getLayers().length);
  log('');
  log('5b. barre rapide : Urgences');
  $('#filtres button[data-filtre="urgences"]').click();
  await att(1200);
  log('   compteur="' + $('#compteur-filtre').textContent + '"'
    + ' | lignes=' + $$('#liste-hopitaux .ligne-hopital').length
    + ' | marqueurs=' + window.MapView.couches.hopitaux.getLayers().length);
  log('   case a cocher urgences = ' + $('#filtre-type-urgences').checked);
  const badgesUr = $$('#liste-hopitaux .badge--urgence').length;
  log('   lignes portant le badge Urgences = ' + badgesUr
    + ' / ' + $$('#liste-hopitaux .ligne-hopital').length);
  log('   points sans-etablissement dans la liste = '
    + D.filterHospitals({ urgence: false }).length);
  log('');
  log('5c. retour a Tous par la barre rapide');
  $('#filtres button[data-filtre="tous"]').click();
  await att(1200);
  log('   compteur="' + $('#compteur-filtre').textContent + '"'
    + ' | marqueurs=' + window.MapView.couches.hopitaux.getLayers().length);
  log('');
  log('5d. case a cocher seule (sans passer par la barre)');
  // On passe par un vrai évènement : un clic utilisateur déclenche `change`,
  // ce que ne fait pas une affectation directe de `.checked`.
  $('#filtre-type-urgences').checked = true;
  $('#filtre-type-urgences').dispatchEvent(new Event('change', { bubbles: true }));
  log('   exclusivite : tous decoche=' + !$('#filtre-type-tous').checked);
  $('#btn-rechercher').click();
  await att(1500);
  log('   compteur="' + $('#compteur-filtre').textContent + '"'
    + ' | marqueurs=' + window.MapView.couches.hopitaux.getLayers().length
    + ' | barre rapide urgences actif='
    + $('#filtres button[data-filtre="urgences"]').classList.contains('actif'));
  log('5e. decocher les urgences, Tous se coche tout seul ?');
  $('#filtre-type-urgences').checked = false;
  $('#filtre-type-urgences').dispatchEvent(new Event('change', { bubbles: true }));
  log('   tous coche=' + $('#filtre-type-tous').checked);
  $('#btn-rechercher').click();
  await att(1500);
  log('   compteur="' + $('#compteur-filtre').textContent + '"'
    + ' | marqueurs=' + window.MapView.couches.hopitaux.getLayers().length);
  log('');

  log('6. reinitialisation :');
  $('#btn-reinitialiser').click();
  await att(2500);
  log('   compteur="' + $('#compteur-filtre').textContent + '"');
  log('   departement=' + JSON.stringify($('#filtre-departement').value));
  log('   filtre MapView=' + JSON.stringify(window.MapView.filtreDepartement));
  log('   resume = "' + $('#resume-filtre').textContent + '"');
  let opacite = 0;
  window.MapView.couches.communes.eachLayer(l => { if (l.__commune) { opacite = l.options.fillOpacity; return false; } });
  log('   opacite de remplissage revenue a ' + opacite);
  log('');

  log('7. recherche dans le champ :');
  $('#recherche').value = 'Bordeaux';
  $('#recherche').dispatchEvent(new Event('input'));
  await att(500);
  log('   resultats=' + $$('#resultats .resultat').length
    + ' | premier="' + ($$('#resultats .resultat')[0] || {textContent:'—'}).textContent.replace(/\s+/g,' ').trim().slice(0,60) + '"');
  log('');

  log('8. itineraire vers le premier hopital du pays :');
  const h = D.hopitaux.find(x => x.nom && x.nom.includes('Bordeaux')) || D.hopitaux[0];
  $('#route-depart').value = String(D.hopitaux.find(x => x.nom !== h.nom).id);
  $('#route-destination').value = String(h.id);
  $('#btn-route').click();
  await att(14000);
  log('   bloc visible=' + !$('#route-resultat').hidden);
  log('   distance=' + $('#route-distance').textContent + ' | duree=' + $('#route-duree').textContent);
  log('   lien=' + $('#route-google').getAttribute('href').slice(0, 70));
  log('   trace=' + window.MapView.couches.route.getLayers().length + ' couche(s)');
  log('');

  log('9. zoom sur une commune :');
  const paris = D.communes.find(c => c.code === '75056');
  log('   Paris population=' + (paris ? paris.population : 'ABSENT')
    + ' hopitaux=' + (paris ? paris.nbHopitaux : '-'));
  if (paris) { window.MapView.carte.setView(paris.centre, 13, {animate:false}); U.ouvrirFicheCommune(paris); }
  await att(2500);
  log('   fiche ouverte=' + $('#fiche-commune').classList.contains('ouvert'));
  log('   texte="' + $('#fiche-commune').textContent.replace(/\s+/g,' ').trim().slice(0,120) + '"');
  log('');
  log('10. notifications affichees = ' + $$('#notifications .note').length);
  document.title = 'FIN';
  log('--- fin ---');
})();
</script>
"""


def main() -> None:
    html = PAGE.read_text(encoding="utf-8")
    marque = "</body>"
    if marque not in html:
        raise SystemExit("</body> introuvable dans index.html")
    # Le journal doit exister avant le chargement des modules.
    tete = '<script>window.__log=[];</script>\n'
    sortie = html.replace("<link rel=\"preconnect\"", tete + "<link rel=\"preconnect\"", 1)
    sortie = sortie.replace(marque, SCENARIO + marque, 1)
    SORTIE.write_text(sortie, encoding="utf-8")
    print(f"[ok] {SORTIE.name} écrit ({len(sortie)} caractères)")


if __name__ == "__main__":
    main()