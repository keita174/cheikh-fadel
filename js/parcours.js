/* ==========================================================================
   Parcours — navigation entre les deux vues, filtres et itinéraire.

   Sépare de app.js, qui ne fait que charger les données : ici tout ce qui
   réagit à un clic de l'utilisateur sur l'interface.

   Le couple #recherche / #resultats n'existe qu'une seule fois dans le
   document ; il est déplacé entre le bandeau d'accueil et l'en-tête de la
   carte selon la vue. Un seul champ, donc jamais deux états divergents.
   ========================================================================== */
(function (global) {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  /** Libellés des départements, pour que « 13 » se lise « Bouches-du-Rhône ». */
  const DEPARTEMENTS = {
    '01': 'Ain', '02': 'Aisne', '03': 'Allier', '04': 'Alpes-de-Haute-Provence',
    '05': 'Hautes-Alpes', '06': 'Alpes-Maritimes', '07': 'Ardèche',
    '08': 'Ardennes', '09': 'Ariège', '10': 'Aube', '11': 'Aude', '12': 'Aveyron',
    '13': 'Bouches-du-Rhône', '14': 'Calvados', '15': 'Cantal', '16': 'Charente',
    '17': 'Charente-Maritime', '18': 'Cher', '19': 'Corrèze', '2A': 'Corse-du-Sud',
    '2B': 'Haute-Corse', '21': "Côte-d'Or", '22': "Côtes-d'Armor", '23': 'Creuse',
    '24': 'Dordogne', '25': 'Doubs', '26': 'Drôme', '27': 'Eure', '28': 'Eure-et-Loir',
    '29': 'Finistère', '30': 'Gard', '31': 'Haute-Garonne', '32': 'Gers',
    '33': 'Gironde', '34': 'Hérault', '35': 'Ille-et-Vilaine', '36': 'Indre',
    '37': 'Indre-et-Loire', '38': 'Isère', '39': 'Jura', '40': 'Landes',
    '41': 'Loir-et-Cher', '42': 'Loire', '43': 'Haute-Loire', '44': 'Loire-Atlantique',
    '45': 'Loiret', '46': 'Lot', '47': 'Lot-et-Garonne', '48': 'Lozère',
    '49': 'Maine-et-Loire', '50': 'Manche', '51': 'Marne', '52': 'Haute-Marne',
    '53': 'Mayenne', '54': 'Meurthe-et-Moselle', '55': 'Meuse', '56': 'Morbihan',
    '57': 'Moselle', '58': 'Nièvre', '59': 'Nord', '60': 'Oise', '61': 'Orne',
    '62': 'Pas-de-Calais', '63': 'Puy-de-Dôme', '64': 'Pyrénées-Atlantiques',
    '65': 'Hautes-Pyrénées', '66': 'Pyrénées-Orientales', '67': 'Bas-Rhin',
    '68': 'Haut-Rhin', '69': 'Rhône', '70': 'Haute-Saône', '71': 'Saône-et-Loire',
    '72': 'Sarthe', '73': 'Savoie', '74': 'Haute-Savoie', '75': 'Paris',
    '76': 'Seine-Maritime', '77': 'Seine-et-Marne', '78': 'Yvelines',
    '79': 'Deux-Sèvres', '80': 'Somme', '81': 'Tarn', '82': 'Tarn-et-Garonne',
    '83': 'Var', '84': 'Vaucluse', '85': 'Vendée', '86': 'Vienne', '87': 'Haute-Vienne',
    '88': 'Vosges', '89': 'Yonne', '90': 'Territoire de Belfort', '91': 'Essonne',
    '92': 'Hauts-de-Seine', '93': 'Seine-Saint-Denis', '94': 'Val-de-Marne',
    '95': "Val-d'Oise", '971': 'Guadeloupe', '972': 'Martinique', '973': 'Guyane',
    '974': 'La Réunion', '976': 'Mayotte',
  };

  const Parcours = {
    vue: 'accueil',
    /** Filtre courant, partagé avec app.js et ui.js. */
    etat: {
      departement: '',
      urgence: false,
      garde: false,
      rayonKm: null,
      position: null,
      derniereDistance: null,
    },

    /* ---------------------------------------------------------------- */
    /* Navigation entre les vues                                        */
    /* ---------------------------------------------------------------- */

    /**
     * Bascule entre l'accueil et la carte.
     *
     * La carte Leaflet n'est initialisée qu'au premier affichage : dans un
     * conteneur masqué elle n'a ni largeur ni hauteur, et les positions de
     * tuiles seraient fausses dès le premier déplacement.
     */
    async aller(vue) {
      if (vue === this.vue) {
        global.scrollTo({ top: 0, behavior: 'smooth' });
        return;
      }
      const accueil = $('#vue-accueil');
      const carte = $('#vue-carte');

      if (vue === 'carte') {
        // Le champ de recherche quitte le bandeau pour l'en-tête de la carte.
        $('#slot-recherche-carte').appendChild($('#bloc-recherche'));

        accueil.hidden = true;
        carte.hidden = false;

        if (!global.MapView || !global.MapView.carte) {
          await global.initialiserCarte();
        }
        // Leaflet a mesuré un conteneur masqué (0×0) : il faut le recalculer.
        setTimeout(() => global.MapView.carte.invalidateSize(), 60);
        this.remplirSelecteursRoute();
      } else {
        $('#slot-recherche').appendChild($('#bloc-recherche'));
        carte.hidden = true;
        accueil.hidden = false;
      }

      this.vue = vue;
      $$('.nav [data-vue]').forEach((b) => {
        b.classList.toggle('actif', b.dataset.vue === vue);
        if (b.tagName === 'A') b.setAttribute('aria-current', b.dataset.vue === vue ? 'page' : 'false');
      });
      document.title = vue === 'carte'
        ? 'Carte interactive — Carte Médicale'
        : 'Carte Médicale — Trouvez un hôpital en France';
    },

    /* ---------------------------------------------------------------- */
    /* Branchement des contrôles                                        */
    /* ---------------------------------------------------------------- */

    brancher() {
      $$('[data-aller-carte]').forEach((b) => b.addEventListener('click', (e) => {
        e.preventDefault();
        // Le bouton « Urgences » de la navigation ouvre la carte sur le filtre
        // correspondant : il n'est pas une destination, seulement une action.
        if (b.hasAttribute('data-ouvrir-urgences')) this.basculerUrgences(true);
        this.aller('carte');
      }));
      $$('[data-aller-accueil]').forEach((b) => b.addEventListener('click', (e) => {
        e.preventDefault();
        this.aller('accueil');
      }));

      $('#puce-urgences').addEventListener('click', () => {
        this.basculerUrgences(true);
        this.aller('carte');
      });
      $('#puce-garde').addEventListener('click', () => {
        global.UI.notifier(
          "Aucun champ de garde n'existe dans les sources : ce filtre est "
          + "désactivé plutôt que d'afficher une information inventée.",
          'info', 9000);
      });

      $$('[data-masquer]').forEach((b) => b.addEventListener('click', () => {
        const cible = b.dataset.masquer === 'route' ? $('#flotant-route') : $('.flotant--filtres');
        cible.style.display = 'none';
      }));

      $('#btn-rechercher').addEventListener('click', () => this.appliquer());
      $('#btn-reinitialiser').addEventListener('click', () => this.reinitialiser());

      // Les deux cases décrivent un choix, pas deux filtres empilables.
      // Invariant : exactement l'une des deux est cochée. Sans cela, décocher
      // « urgences » laissait les deux décochées, un état qui n'a pas de nom
      // et que l'utilisateur ne sait pas interpréter.
      $('#filtre-type-tous').addEventListener('change', (e) => {
        $('#filtre-type-urgences').checked = !e.target.checked;
      });
      $('#filtre-type-urgences').addEventListener('change', (e) => {
        $('#filtre-type-tous').checked = !e.target.checked;
      });
      $('#btn-route').addEventListener('click', () => this.calculerItineraire());

      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && this.vue === 'carte') {
          const ouvertes = $$('.volet.ouvert');
          if (ouvertes.length) ouvertes.forEach((v) => v.classList.remove('ouvert'));
        }
      });
    },

    basculerUrgences(actif) {
      this.etat.urgence = actif;
      // Les deux cases du panneau et la barre rapide forment un choix unique,
      // pas deux filtres cumulables : « Tous » et « avec urgences » cochés
      // ensemble ne signifieraient rien de vérifiable. `basculerUrgences` est
      // le seul endroit qui décide, donc c'est le seul qui propage.
      const btnUrg = $('#filtre-type-urgences');
      if (btnUrg) btnUrg.checked = actif;
      const btnTous = $('#filtre-type-tous');
      if (btnTous) btnTous.checked = !actif;

      const puce = $('#puce-urgences');
      if (puce) puce.setAttribute('aria-pressed', String(actif));

      const rapide = $('#filtres button[data-filtre="urgences"]');
      if (rapide) {
        rapide.classList.toggle('actif', actif);
        rapide.setAttribute('aria-pressed', String(actif));
      }
      const rapideTous = $('#filtres button[data-filtre="tous"]');
      if (rapideTous) {
        rapideTous.classList.toggle('actif', !actif);
        rapideTous.setAttribute('aria-pressed', String(!actif));
      }
    },

    /* ---------------------------------------------------------------- */
    /* Filtres                                                          */
    /* ---------------------------------------------------------------- */

    /** Remplit la liste des départements d'après les communes connues. */
    remplirDepartements() {
      const select = $('#filtre-departement');
      if (!select || select.dataset.REMPLI === '1') return;

      const codes = new Set();
      for (const c of global.DataManager.communes) {
        if (c.departement) codes.add(String(c.departement));
      }
      // Deux communes suffisent : c'est le même département, pas deux.
      if (codes.size < 2) return;

      const options = [...codes]
        .sort()
        .map((d) => `<option value="${d}">${DEPARTEMENTS[d] || 'Département ' + d} (${d})</option>`)
        .join('');
      select.insertAdjacentHTML('beforeend', options);
      select.dataset.REMPLI = '1';
    },

    /** Applique les filtres du panneau et met la liste à jour. */
    appliquer() {
      this.etat.departement = $('#filtre-departement').value;
      // La case « urgences » décide. Les deux cases étant exclusives par
      // construction — cocher l'une décoche l'autre — il n'y a pas d'état
      // contradictoire à arbitrer ; s'il survenait quand même, le filtre le
      // plus précis l'emporte, parce que c'est celui que l'utilisateur vient
      // de cocher.
      this.etat.urgence = $('#filtre-type-urgences').checked;

      const liste = global.DataManager.filterHospitals(this.etat);

      // Les contours suivent le filtre : ils sont estompés hors du
      // département plutôt que supprimés, pour que le territoire reste lisible.
      const M = global.MapView;
      if (M.appliquerFiltreDepartement) {
        M.appliquerFiltreDepartement(this.etat.departement);
        if (this.etat.departement) M.cadrerDepartement(this.etat.departement);
        else M.cadrerFrance();
      }

      this.basculerUrgences(this.etat.urgence);
      global.UI.appliquerFiltre(this.etat.urgence ? 'urgences' : 'tous', liste);
      this.majResume();
      this.remplirSelecteursRoute();
    },

    /** Écrit le rappel de périmètre sous les filtres. */
    majResume() {
      const el = $('#resume-filtre');
      if (!el) return;
      const texte = this.resumeFiltre();
      el.textContent = texte || '';
    },

    /** Message décrivant ce que le filtre de département a donné. */
    resumeFiltre() {
      const dep = this.etat.departement;
      if (!dep) return null;
      const M = global.MapView;
      const communes = M.compterCommunes ? M.compterCommunes(dep) : 0;
      const hopitaux = global.DataManager.filterHospitals(this.etat).length;
      const label = DEPARTEMENTS[dep] || `département ${dep}`;
      return `${label} : ${communes.toLocaleString('fr-FR')} communes, `
        + `${hopitaux.toLocaleString('fr-FR')} établissements affichés. `
        + `Les communes voisines restent tracées, en plus clair.`;
    },

    reinitialiser() {
      $('#filtre-departement').value = '';
      $('#filtre-type-tous').checked = true;
      $('#filtre-type-urgences').checked = false;
      $('#filtre-type-garde').checked = false;
      this.etat.departement = '';
      this.etat.urgence = false;
      this.etat.garde = false;
      this.etat.rayonKm = null;

      const btnTous = $('#filtres button[data-filtre="tous"]');
      if (btnTous) { btnTous.classList.add('actif'); btnTous.setAttribute('aria-pressed', 'true'); }
      const btnUrg = $('#filtres button[data-filtre="urgences"]');
      if (btnUrg) { btnUrg.classList.remove('actif'); btnUrg.setAttribute('aria-pressed', 'false'); }
      this.basculerUrgences(false);

      if (global.MapView.appliquerFiltreDepartement) {
        global.MapView.appliquerFiltreDepartement('');
        global.MapView.cadrerFrance();
      }
      global.UI.appliquerFiltre('tous', global.DataManager.hopitaux);
      this.majResume();
      global.UI.notifier(
        `Filtres réinitialisés : ${global.DataManager.totalCommunes.toLocaleString('fr-FR')} `
        + 'communes et tous les établissements sont affichés.', 'info', 5000);
    },

    /* ---------------------------------------------------------------- */
    /* Itinéraire                                                        */
    /* ---------------------------------------------------------------- */

    /** Alimente les deux listes déroulantes du panneau Itinéraire. */
    remplirSelecteursRoute() {
      const depart = $('#route-depart');
      const dest = $('#route-destination');
      if (!depart || !dest || dest.dataset.REMPLI === '1') return;

      const options = global.DataManager.hopitaux
        .slice()
        .sort((a, b) => a.nom.localeCompare(b.nom, 'fr'))
        .map((h) => `<option value="${h.id}">${global.UI.echapper(h.nom)}</option>`)
        .join('');

      depart.insertAdjacentHTML('beforeend', options);
      dest.insertAdjacentHTML('beforeend', options);
      dest.dataset.REMPLI = '1';
    },

    async calculerItineraire() {
      const D = global.DataManager;
      const idDest = $('#route-destination').value;
      const idDepart = $('#route-depart').value;

      if (!idDest) {
        global.UI.notifier("Choisissez d'abord un établissement de destination.", 'info', 6000);
        return;
      }
      const destination = D.hopitaux.find((h) => String(h.id) === String(idDest));
      if (!destination) return;

      let depart;
      if (!idDepart || this.etat.position) {
        // Position de l'utilisateur si on la connaît, sinon l'établissement
        // sélectionné au départ.
        if (this.etat.position) {
          depart = [this.etat.position.lat, this.etat.position.lon];
        } else {
          global.UI.notifier(
            "Aucune position connue : activez « Autour de moi », ou "
            + "choisissez un établissement de départ.", 'info', 8000);
          return;
        }
      } else {
        const h = D.hopitaux.find((x) => String(x.id) === String(idDepart));
        if (!h) return;
        depart = [h.lat, h.lon];
      }

      const btn = $('#btn-route');
      btn.disabled = true;
      const texte = btn.textContent;
      btn.textContent = 'Calcul en cours…';

      const arrivee = [destination.lat, destination.lon];
      const r = await global.Routing.calculer(depart, arrivee, 'voiture');

      btn.disabled = false;
      btn.innerHTML = texte;

      const bloc = $('#route-resultat');
      bloc.hidden = false;

      if (!r.ok) {
        // Pas de fausse distance : on le dit et on renvoie vers un service
        // qui sait calculer.
        $('#route-distance').innerHTML = '<span class="vide">non disponible</span>';
        $('#route-duree').innerHTML = '<span class="vide">non disponible</span>';
        const lien = $('#route-google');
        lien.href = global.Routing.lienExterne(depart, arrivee, 'voiture');
        lien.querySelector('svg').outerHTML =
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" '
          + 'stroke-linecap="round" stroke-linejoin="round"><path d="M14 3h7v7"/>'
          + '<path d="M10 14 21 3"/><path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5'
          + 'a2 2 0 0 1 2-2h5"/></svg>';
        lien.lastChild.textContent = ' Ouvrir dans OpenStreetMap';
        global.UI.notifier(
          `Service d'itinéraire indisponible (${r.raison}). `
          + `L'itinéraire est proposé dans OpenStreetMap.`, 'info', 9000);
        return;
      }

      $('#route-distance').textContent = `${r.distance.toFixed(1).replace('.', ',')} km`;
      const d = Math.round(r.duree);
      $('#route-duree').textContent = d >= 60
        ? `${Math.floor(d / 60)} h ${String(d % 60).padStart(2, '0')}`
        : `${d} min`;

      const lien = $('#route-google');
      lien.href = `https://www.google.com/maps/dir/?api=1`
        + `&origin=${depart[0]},${depart[1]}`
        + `&destination=${arrivee[0]},${arrivee[1]}`
        + `&travelmode=driving`;

      global.MapView.afficherRoute(r.geometry);
      global.MapView.animerRoute();
    },

    /* ---------------------------------------------------------------- */
    /* Chiffres du bandeau d'accueil                                     */
    /* ---------------------------------------------------------------- */

    majChiffres() {
      const D = global.DataManager;
      const s = D.stats();
      const deps = new Set(D.hopitaux.map((h) => h.depCommune).filter(Boolean)).size;
      const depsCommunes = new Set(D.communes.map((c) => String(c.departement || ''))).size;

      const ecrire = (id, valeur) => {
        const el = document.getElementById(id);
        if (el) el.textContent = valeur.toLocaleString('fr-FR');
      };
      ecrire('stat-hero-etablissements', s.hopitaux);
      ecrire('stat-hero-communes', D.totalCommunes);
      ecrire('stat-hero-urgences', s.urgences);
      ecrire('stat-hero-departements', depsCommunes || deps);

      // Les mêmes chiffres dans l'en-tête de la carte.
      global.UI.majStats();
    },
  };

  global.Parcours = Parcours;
})(window);