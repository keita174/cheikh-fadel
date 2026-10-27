/* ==========================================================================
   Amorçage — chargement des données et mise en route.

   Deux vues, deux temps :
     1. au démarrage, seuls les établissements sont chargés : ils suffisent à
        remplir les chiffres du bandeau d'accueil, et c'est ce que voit
        d'abord le visiteur ;
     2. la carte n'est créée qu'à la demande, parce qu'une carte Leaflet
        initialisée dans un conteneur masuré n'a ni largeur ni hauteur, et
        placerait ses tuiles n'importe où au premier déplacement.
   ========================================================================== */
(function (global) {
  'use strict';

  const $ = (sel) => document.querySelector(sel);

  let cartePrete = false;

  /** Affiche une aide si la page est ouverte en `file://`. */
  function verifierProtocole() {
    if (location.protocol !== 'file:') return;
    const R = '/xampp/htdocs';
    const url = location.origin + '/' + R + location.pathname
      .split('/').slice(1).join('/').replace(/^PROJET%20SIG%20AIX/, 'PROJET%20SIG%20AIX');
    global.UI.notifier(
      "Ouverte directement depuis le disque, la page ne peut pas appeler "
      + "les API : le navigateur bloque les requêtes hors de son origine. "
      + "Démarrez Apache, puis ouvrez : " + url,
      'erreur', 0);
  }

  /** Crée la carte, trace les communes, affiche les établissements. */
  async function initialiserCarte() {
    if (cartePrete) return;
    cartePrete = true;

    const D = global.DataManager;
    global.UI.chargement(true, 'Chargement des 34 877 communes…');

    // La couche est déjà peut-être chargée si l'utilisateur a ouvert la
    // carte avant que le chargement d'accueil ne finisse.
    if (!D.communes.length) {
      try {
        await D.loadCommunes();
      } catch (e) {
        cartePrete = false;
        global.UI.chargement(false);
        global.UI.notifier(
          'Les contours des communes sont indisponibles : la carte affiche '
          + 'les établissements sans le fond communal.', 'erreur', 9000);
        return;
      }
    }

    global.MapView.init('carte', { zoomControl: false, attributionControl: true });
    global.MapView.changerFond('sobre');
    global.MapView.cadrerFrance();
    global.MapView.afficherCommunes(D.communes, (c) => global.UI.ouvrirFicheCommune(c));

    global.UI.brancherRecherche();
    brancherControlesCarte();
    brancherPanneaux();

    $('#vue-carte').classList.add('chargee');
    // La liste et les marqueurs ne sont posés qu'ici : avant, il n'y a pas de
    // carte où les dessiner.
    global.UI.appliquerFiltre(Parcours.etat.urgence ? 'urgences' : 'tous', D.hopitaux);
    global.UI.chargement(false);
    global.Parcours.remplirDepartements();
    global.Parcours.remplirSelecteursRoute();
    global.Parcours.majResume();
    global.Parcours.majChiffres();

    global.UI.etatDonnees(
      `${D.stats().hopitaux.toLocaleString('fr-FR')} établissements · `
      + `${D.totalCommunes.toLocaleString('fr-FR')} communes`);
  }
  global.initialiserCarte = initialiserCarte;

  /** Boutons de la carte, dont le rayon de recherche. */
  function brancherControlesCarte() {
    const M = global.MapView;
    const D = global.DataManager;
    const P = global.Parcours;

    $('#zoom-plus').addEventListener('click', () => M.carte.zoomIn());
    $('#zoom-moins').addEventListener('click', () => M.carte.zoomOut());
    $('#recentre').addEventListener('click', () => M.cadrerFrance());

    $('#btn-position').addEventListener('click', () => global.UI.demanderPosition());

    // Fond de carte : le fond par défaut est presque gris, pour que la couleur
    // des communes soit la seule couleur de l'écran. Le fond détaillé reste
    // accessible pour qui a besoin des noms de rues et du relief.
    const btnFond = $('#btn-fond');
    if (btnFond) {
      const majAria = (nom) => {
        const sobre = nom === 'sobre';
        btnFond.setAttribute('aria-pressed', String(sobre));
        btnFond.title = sobre
          ? 'Fond sobre — cliquer pour le fond détaillé'
          : 'Fond détaillé — cliquer pour le fond sobre';
        btnFond.classList.toggle('actif', sobre);
      };
      majAria(M.nomFond);
      btnFond.addEventListener('click', () => {
        const nom = M.nomFond === 'sobre' ? 'detaille' : 'sobre';
        M.changerFond(nom);
        majAria(nom);
      });
    }

    // La légende reprend la rampe telle qu'elle est appliquée à la carte.
    const ul = $('#legende-classes');
    if (ul) {
      ul.innerHTML = M.CLASSES.map(c =>
        `<li><span class="pastille" style="background:${c.couleur}"></span>${c.texte}</li>`
      ).join('');
    }

    $('#rayon').addEventListener('change', (e) => {
      const v = e.target.value;
      P.etat.rayonKm = v === '' ? null : Number(v);
      if (!P.etat.position) {
        global.UI.notifier(
          "Rayon inactif : aucune position connue. Utilisez « Autour de moi ».",
          'info', 6000);
        return;
      }
      const liste = D.filterHospitals(P.etat);
      global.UI.appliquerFiltre(P.etat.urgence ? 'urgences' : 'tous', liste);
      M.afficherRayon(P.etat.position, P.etat.rayonKm);
    });

    // Barre de filtres rapide : « Tous », « Urgences », « De garde ».
    // Elle ne fait qu'un seul chose, toujours par le même chemin que le
    // panneau Filtres : changer l'état, puis redemander la liste à
    // DataManager. Deux chemins de filtrage distincts finiraient par diverger.
    $('#filtres').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-filtre]');
      if (!b || b.disabled) return;

      const urgent = b.dataset.filtre === 'urgences';
      P.basculerUrgences(urgent);
      // La case à cocher du panneau suit la barre, et réciproquement : les
      // deux contrôles affichent le même état.
      $('#filtre-type-urgences').checked = urgent;
      $('#filtre-type-tous').checked = !urgent;

      $$('#filtres button[data-filtre]').forEach((x) => {
        x.classList.toggle('actif', x === b);
        x.setAttribute('aria-pressed', String(x === b));
      });

      const liste = D.filterHospitals(P.etat);
      global.UI.appliquerFiltre(urgent ? 'urgences' : 'tous', liste);
    });

    // La liste attache déjà son propre gestionnaire à chaque ligne
    // (ui.afficherListe), il n'y a donc rien à déléguer ici.

    document.addEventListener('click', (e) => {
      if (!e.target.closest('.recherche-bloc')) $('#resultats').classList.remove('ouvert');
    });

    M.carte.on('click', () => {
      $$('.volet.ouvert').forEach((v) => v.classList.remove('ouvert'));
      M.selectionnerCommune(null);
    });
  }

  const $$ = (s) => Array.from(document.querySelectorAll(s));

  /** Les onglets d'un établissement : itinéraire vers celui-ci. */
  function brancherPanneaux() {
    $('#panneau-proche').addEventListener('click', (e) => {
      const b = e.target.closest('[data-itineraire]');
      if (!b) return;
      const P = global.Parcours;
      const h = global.DataManager.hopitaux.find((x) => String(x.id) === b.dataset.itineraire);
      if (!h) return;
      $('#flotant-route').style.display = '';
      $('#route-depart').value = '';
      $('#route-destination').value = String(h.id);
      P.calculerItineraire();
    });
  }

  /** Chargement initial : les établissements, puis le reste. */
  async function demarrer() {
    const ui = global.UI;
    verifierProtocole();
    global.Parcours.brancher();

    ui.chargement(true, 'Chargement des établissements de santé…');

    try {
      await global.DataManager.loadHospitals();
      global.Parcours.majChiffres();
    } catch (e) {
      ui.notifier(
        'Impossible de charger les établissements de santé. Les API sont-elles '
        + 'démarrées ?', 'erreur', 0);
      ui.chargement(false);
      return;
    }

    ui.majStats();
    ui.chargement(false);

    const D = global.DataManager;
    ui.etatDonnees(
      `${D.stats().hopitaux.toLocaleString('fr-FR')} établissements chargés`);

    // Le filtre « garde » n'apparaît que si la donnée existe. Elle n'existe
    // pas ici : mieux vaut un filtre désactivé qu'une information inventée.
    const rapide = $('#filtres button[data-filtre="garde"]');
    if (rapide && !D.gardeDisponible) {
      rapide.disabled = true;
      rapide.title = 'Aucun champ de garde dans les données sources.';
    }

    // Les communes sont lancées en tâche de fond : l'accueil n'en a pas
    // besoin immédiatement, mais elles seront prêtes si l'utilisateur ouvre
    // la carte avant d'avoir fini de lire.
    D.loadCommunes().then(() => {
      global.Parcours.majChiffres();
      ui.etatDonnees(
        `${D.stats().hopitaux.toLocaleString('fr-FR')} établissements · `
        + `${D.totalCommunes.toLocaleString('fr-FR')} communes`);
    }).catch(() => { /* l'erreur est déjà signalée à l'ouverture de la carte */ });

    if (D.gardeDisponible === false) {
      const caseGarde = $('#case-garde');
      if (caseGarde) {
        caseGarde.insertAdjacentHTML('afterend',
          '<p class="note-desactive" role="note">Aucune information de garde '
          + "n'existe dans les API : ce filtre reste désactivé plutôt que "
          + "d'afficher une donnée inventée.</p>");
      }
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', demarrer);
  } else {
    demarrer();
  }
})(window);