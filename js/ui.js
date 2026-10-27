/**
 * UI — panneaux, filtres, recherche, fiches, notifications.
 *
 * Chaque élément n'est affiché que si la donnée existe. Une information
 * absente des API n'est jamais remplacée par une valeur plausible : le champ
 * correspondant disparaît, et les fonctionnalités concernées sont désactivées
 * avec une explication visible.
 */
(function (global) {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  const UI = {
    position: null,        // { lat, lon }
    rayonKm: null,
    filtre: 'tous',
    hopitauxCourants: [],
    communeCourante: null,
    hopitalCourant: null,
    itineraire: null,      // établissement cible de l'itinéraire courant
    modeRoute: 'voiture',

    /* ---------------------------------------------------------------- */
    /* Notifications                                                     */
    /* ---------------------------------------------------------------- */
    notifier(message, type = 'info', duree = 5000) {
      const zone = $('#notifications');
      const el = document.createElement('div');
      el.className = `notification notification--${type}`;
      el.setAttribute('role', type === 'erreur' ? 'alert' : 'status');
      el.textContent = message;
      zone.appendChild(el);
      setTimeout(() => {
        el.classList.add('sortie');
        setTimeout(() => el.remove(), 400);
      }, duree);
    },

    /* ---------------------------------------------------------------- */
    /* Chargement                                                       */
    /* ---------------------------------------------------------------- */
    chargement(actif, texte) {
      const voile = $('#chargement');
      if (!voile) return;
      // `cache` signifie « le voile est rangé ». La classe `actif` est
      // également posée, pour qu'un état lisible reste disponible au
      // débogage ; c'est `cache` que la feuille de style surveille.
      voile.classList.toggle('cache', !actif);
      voile.classList.toggle('actif', !!actif);
      voile.setAttribute('aria-busy', actif ? 'true' : 'false');
      if (texte) $('#chargement-texte').textContent = texte;
    },

    etatDonnees(message, erreur = false) {
      const el = $('#etat-donnees');
      el.textContent = message;
      el.classList.toggle('erreur', erreur);
    },

    /* ---------------------------------------------------------------- */
    /* Tableau de bord                                                  */
    /* ---------------------------------------------------------------- */
    majStats() {
      const s = global.DataManager.stats();
      // Les compteurs ne sont pas présents dans toutes les vues : sur la page
      // d'accueil ils n'existent pas, les chiffres sont dans des cartes.
      // Écrire dans un élément absent interromprait le rendu de la liste.
      const ecrire = (sel, valeur) => {
        const el = $(sel);
        if (el) el.textContent = valeur;
      };
      ecrire('#stat-hopitaux', s.hopitaux.toLocaleString('fr-FR'));
      ecrire('#stat-urgences', s.urgences.toLocaleString('fr-FR'));
      ecrire('#stat-communes',
        (global.DataManager.totalCommunes || s.communes).toLocaleString('fr-FR'));
      // Pas de donnée de garde : on affiche « — » plutôt qu'un 0 qui ferait
      // croire à une absence d'établissements de garde.
      const elGarde = $('#stat-garde');
      if (elGarde) {
        elGarde.textContent = s.garde === null ? '—' : s.garde.toLocaleString('fr-FR');
        elGarde.parentElement.classList.toggle('indisponible', s.garde === null);
      }
    },

    /* ---------------------------------------------------------------- */
    /* Filtres                                                          */
    /* ---------------------------------------------------------------- */
    majFiltres() {
      const n = this.hopitauxCourants.length;
      $('#compteur-filtre').textContent =
        n === 0 ? 'aucun établissement'
          : n === 1 ? '1 établissement'
            : `${n.toLocaleString('fr-FR')} établissements`;
      $$('#filtres button').forEach(b => {
        const actif = b.dataset.filtre === this.filtre;
        b.classList.toggle('actif', actif);
        b.setAttribute('aria-pressed', actif ? 'true' : 'false');
      });
    },

    appliquerFiltre(nom, hopitaux) {
      this.filtre = nom;
      this.hopitauxCourants = hopitaux;
      global.MapView.afficherHopitaux(hopitaux);
      this.majFiltres();
      this.afficherListe(hopitaux);
      this.majStats();
    },

    /* ---------------------------------------------------------------- */
    /* Liste des établissements triés par distance                      */
    /* ---------------------------------------------------------------- */
    afficherListe(hopitaux) {
      const zone = $('#liste-hopitaux');
      zone.innerHTML = '';
      if (!hopitaux.length) {
        zone.innerHTML = '<p class="vide">Aucun établissement ne correspond à ce filtre.</p>';
        return;
      }
      const tries = this.position
        ? [...hopitaux].sort((a, b) => (a.distance ?? 1e9) - (b.distance ?? 1e9))
        : hopitaux;

      const fragment = document.createDocumentFragment();
      tries.slice(0, 300).forEach((h, i) => {
        const li = document.createElement('button');
        li.className = 'ligne-hopital' + (i === 0 && this.position ? ' plus-proche' : '');
        li.type = 'button';
        const badges = [
          h.urgence ? '<span class="badge badge--urgence">Urgences</span>' : '',
          h.garde ? '<span class="badge badge--garde">De garde</span>' : '',
        ].join('');
        const dist = h.distance !== null
          ? `<span class="ligne-distance">${UI.formaterDistance(h.distance)}</span>` : '';
        const plusProche = i === 0 && this.position ? '<span class="badge badge--proche">★ Plus proche</span>' : '';
        li.innerHTML = `
          <span class="ligne-point ${global.MapView.typeDe(h)}" aria-hidden="true"></span>
          <span class="ligne-corps">
            <span class="ligne-nom">${UI.echapper(h.nom)}</span>
            <span class="ligne-meta">
              ${h.commune || h.ville || 'Commune non précisée'}${badges ? ' · ' + badges : ''}
            </span>
          </span>
          ${dist}`;
        li.addEventListener('click', () => UI.ouvrirFicheHopital(h, true));
        fragment.appendChild(li);
      });
      zone.appendChild(fragment);
      if (tries.length > 300) {
        const p = document.createElement('p');
        p.className = 'vide';
        p.textContent = `… et ${(tries.length - 300).toLocaleString('fr-FR')} autres. Utilisez les filtres ou la recherche.`;
        zone.appendChild(p);
      }
    },

    /* ---------------------------------------------------------------- */
    /* Fiches                                                           */
    /* ---------------------------------------------------------------- */
    /** Contenu de la fiche d'un établissement, en HTML. */
    fichePopup(h) {
      const lignes = [];
      const ligne = (label, valeur, icone = '') => {
        if (valeur === null || valeur === undefined || valeur === '') return;
        lignes.push(`<div class="fiche-ligne">${icone}<div><dt>${label}</dt><dd>${valeur}</dd></div></div>`);
      };
      ligne('Commune', UI.echapper(h.commune || h.ville || '—'), '<span class="ic">◉</span>');
      if (h.adresse) ligne('Adresse', UI.echapper(h.adresse));
      if (h.telephone) ligne('Téléphone', `<a href="tel:${UI.echapper(h.telephone)}">${UI.echapper(h.telephone)}</a>`, '<span class="ic">☎</span>');
      if (h.specialite) ligne('Spécialité', UI.echapper(h.specialite));
      if (h.capacite) ligne('Capacité', UI.echapper(String(h.capacite)));
      if (h.operateur) ligne('Gestionnaire', UI.echapper(h.operateur));
      if (h.accessibilite) ligne('Accessibilité', UI.echapper(h.accessibilite));
      if (h.finess) ligne('FINESS', UI.echapper(h.finess));

      const badges = [];
      if (h.urgence) badges.push('<span class="badge badge--urgence">🚨 Urgences</span>');
      if (h.garde) badges.push('<span class="badge badge--garde">🟢 De garde</span>');
      if (!h.urgence && h.urgenceBrut === null) {
        badges.push('<span class="badge badge--neutre">Service d\'urgence non renseigné</span>');
      }

      const distance = h.distance !== null
        ? `<div class="fiche-distance">📍 ${UI.formaterDistance(h.distance)}</div>` : '';

      return `
        <div class="fiche">
          <h3>${UI.echapper(h.nom)}</h3>
          <div class="badges">${badges.join(' ')}</div>
          ${lignes.length ? `<dl class="fiche-dl">${lignes.join('')}</dl>` : ''}
          ${distance}
          <button type="button" class="btn btn--principal" data-itineraire="${UI.echapper(String(h.id))}">
            Itinéraire
          </button>
        </div>`;
    },

    ouvrirFicheHopital(h, recentrer = false) {
      this.hopitalCourant = h;
      const panneau = $('#fiche-hopital');
      panneau.innerHTML = this.fichePopup(h);
      panneau.classList.add('ouvert');
      panneau.querySelector('[data-itineraire]')
        ?.addEventListener('click', () => this.demarrerItineraire(h));
      if (recentrer && h.marker) {
        global.MapView.carte.flyTo([h.lat, h.lon], Math.max(global.MapView.carte.getZoom(), 13), { duration: 0.7 });
      }
      this.fermerBottomSheetSurDesktop();
    },

    fermerFicheHopital() {
      $('#fiche-hopital').classList.remove('ouvert');
    },

    /** Fiche d'une commune sélectionnée. */
    ouvrirFicheCommune(c) {
      this.communeCourante = c;
      const hops = global.DataManager.hopitaux.filter(h => h.commune === c.nom);
      const liste = hops.length
        ? `<ul class="commune-hopitaux">${hops.slice(0, 40).map(h => `
             <li><button type="button" data-hopital="${UI.echapper(String(h.id))}">
               <span class="ligne-point ${global.MapView.typeDe(h)}" aria-hidden="true"></span>
               ${UI.echapper(h.nom)}
               ${h.urgence ? '<span class="badge badge--urgence">Urgences</span>' : ''}
             </button></li>`).join('')}
           </ul>`
        : '<p class="vide">Aucun établissement de la base n\'est rattaché à cette commune.</p>';

      $('#fiche-commune').innerHTML = `
        <div class="commune-tete">
          <span class="commune-kicker">Commune sélectionnée</span>
          <h3>${UI.echapper(c.nom)}</h3>
          <div class="commune-meta">
            ${c.population ? UI.echapper(c.population.toLocaleString('fr-FR')) + ' habitants' : 'Population non renseignée'}
            ${c.codePostal ? ' · ' + UI.echapper(String(c.codePostal)) : ''}
          </div>
        </div>
        <div class="commune-stats">
          <div><b>${hops.length}</b><span>établissements</span></div>
          <div><b>${c.nbUrgences}</b><span>avec urgences</span></div>
          <div><b>${global.DataManager.gardeDisponible ? c.nbGarde : '—'}</b><span>de garde</span></div>
        </div>
        <h4 class="commune-soustitre">Établissements</h4>
        ${liste}`;
      $('#fiche-commune').classList.add('ouvert');
      $('#fiche-commune').querySelectorAll('[data-hopital]').forEach(b => {
        b.addEventListener('click', () => {
          const h = global.DataManager.hopitaux.find(x => String(x.id) === b.dataset.hopital);
          if (h) this.ouvrirFicheHopital(h, true);
        });
      });
    },

    fermerFicheCommune() {
      $('#fiche-commune').classList.remove('ouvert');
      global.MapView.selectionnerCommune(null);
    },

    /* ---------------------------------------------------------------- */
    /* Infobulle de survol                                              */
    /* ---------------------------------------------------------------- */
    infobulleCommune(c) {
      const el = $('#infobulle');
      if (!c) return;
      el.innerHTML = `<b>${UI.echapper(c.nom)}</b>
        <span>${c.nbHopitaux} établissement${c.nbHopitaux > 1 ? 's' : ''}${c.nbUrgences ? ' · ' + c.nbUrgences + ' urgences' : ''}</span>`;
      el.classList.add('visible');
      this.suivreSouris();
    },
    masquerInfobulle() { $('#infobulle').classList.remove('visible'); },
    suivreSouris() {
      const el = $('#infobulle');
      const move = (e) => {
        const x = e.clientX ?? (e.touches && e.touches[0]?.clientX) ?? 0;
        const y = e.clientY ?? (e.touches && e.touches[0]?.clientY) ?? 0;
        el.style.left = Math.min(x + 14, window.innerWidth - 240) + 'px';
        el.style.top = Math.max(y - 56, 10) + 'px';
      };
      if (!this._sourisLie) {
        document.addEventListener('pointermove', move, { passive: true });
        this._sourisLie = true;
      }
      move(window.MouseEvent ? { clientX: el.offsetLeft, clientY: el.offsetTop } : { clientX: 0, clientY: 0 });
    },

    /* ---------------------------------------------------------------- */
    /* Géolocalisation                                                   */
    /* ---------------------------------------------------------------- */
    demanderPosition() {
      if (!navigator.geolocation) {
        this.notifier('La géolocalisation n\'est pas disponible sur cet appareil.', 'erreur');
        return;
      }
      this.notifier('Votre position est utilisée uniquement pour trouver les '
        + 'établissements proches et tracer votre itinéraire. Rien n\'est stocké.', 'info', 7000);
      this.chargement(true, 'Recherche de votre position…');
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          this.position = { lat: pos.coords.latitude, lon: pos.coords.longitude };
          this.chargement(false);
          this.appliquerAutourDeMoi();
        },
        (err) => {
          this.chargement(false);
          const messages = {
            1: 'Position refusée. Autorisez la localisation pour utiliser « Autour de moi ».',
            2: 'Position indisponible. Réessayez dans un endroit dégagé.',
            3: 'Position introuvable, délai dépassé.',
          };
          this.notifier(messages[err.code] || 'Impossible d\'obtenir votre position.', 'erreur', 8000);
        },
        { enableHighAccuracy: true, timeout: 12000, maximumAge: 30000 }
      );
    },

    appliquerAutourDeMoi() {
      const { lat, lon } = this.position;
      global.DataManager.calcuerDistances(lat, lon);
      global.MapView.afficherPosition(lat, lon, this.rayonKm);
      this.rafraichirListe();
      this.ouvrirPanneauPlusProche();
      this.notifier(`${global.DataManager.hopitaux.filter(h => h.distance !== null).length} `
        + `établissements calculés depuis votre position.`, 'succes');
    },

    /**
     * Panel « les plus proches ».
     *
     * Deux entrées et non une : l'établissement le plus proche, et le plus
     * proche disposant d'urgences. Ils se confondent souvent, mais pas
     * toujours — une clinique à 300 m sans urgences ne répond pas à une
     * urgence. N'afficher que le premier laisserait croire que le plus proche
     * est aussi le plus apte.
     *
     * Chaque entrée porte sa distance réelle et un bouton qui trace le
     * chemin. La fiche détaillée n'est pas ouverte automatiquement : trois
     * panneaux simultanés noyaient la carte.
     */
    ouvrirPanneauPlusProche() {
      const D = global.DataManager;
      const { lat, lon } = this.position || {};
      if (lat === undefined) return;

      const plusProche = D.findNearestHospital(lat, lon);
      if (!plusProche) return;
      const avecUrgences = D.findNearestHospital(lat, lon, { urgence: true });

      const ligne = (h, intitule) => `
        <li class="proche-item${h.urgence ? ' proche-item--urgence' : ''}">
          <span class="proche-intitule">${intitule}</span>
          <strong>${UI.echapper(h.nom)}</strong>
          <span class="proche-lieu">${UI.echapper(h.commune || h.ville || 'Commune non précisée')}</span>
          <span class="proche-distance">${UI.formaterDistance(h.distance)}</span>
          <div class="proche-actions">
            <button type="button" class="btn btn--primaire"
                    data-conduire="${UI.echapper(h.id)}">M'y conduire</button>
            <button type="button" class="btn btn--fantome"
                    data-voir="${UI.echapper(h.id)}">La fiche</button>
          </div>
        </li>`;

      const items = [];
      if (avecUrgences && avecUrgences.id !== plusProche.id) {
        items.push(ligne(avecUrgences, 'Le plus proche avec urgences'));
      }
      items.push(ligne(plusProche, avecUrgences && avecUrgences.id === plusProche.id
        ? 'Le plus proche (avec urgences)'
        : 'Le plus proche'));

      const p = $('#panneau-proche');
      p.innerHTML = `
        <header class="volet-entete">
          <div>
            <h3>Autour de vous</h3>
            <p class="sous">Distances mesurées à vol d'oiseau depuis votre position</p>
          </div>
          <button type="button" class="fermer" aria-label="Fermer">&times;</button>
        </header>
        <div class="volet-corps">
          <ul class="proche-liste">${items.join('')}</ul>
          <button type="button" class="lien-discret" id="btn-itineraire-proche">
            Voir tous les établissements autour de vous
          </button>
        </div>`;

      p.classList.add('ouvert');
      p.querySelector('.fermer').addEventListener('click', () => p.classList.remove('ouvert'));

      // Le lien du bas bascule sur la liste complète autour de la position,
      // dans un rayon de 10 km. Il règle le rayon parce que la liste et le
      // cercle tracer doivent obéir au même réglage.
      const lienTous = $('#btn-itineraire-proche');
      if (lienTous) {
        lienTous.addEventListener('click', () => {
          this.rayonKm = 10;
          const sel = $('#rayon');
          if (sel) sel.value = '10';
          const P = global.Parcours;
          if (P) { P.etat.rayonKm = 10; P.etat.position = this.position; }
          this.rafraichirListe();
          this.notifier(
            `Établissements dans un rayon de 10 km, du plus proche au plus lointain.`,
            'succes', 5000);
        });
      }

      p.querySelectorAll('[data-conduire]').forEach((b) => b.addEventListener('click', () => {
        const h = D.hopitaux.find((x) => String(x.id) === b.dataset.conduire);
        if (h) this.demarrerItineraire(h);
      }));
      p.querySelectorAll('[data-voir]').forEach((b) => b.addEventListener('click', () => {
        const h = D.hopitaux.find((x) => String(x.id) === b.dataset.voir);
        if (h) this.ouvrirFicheHopital(h, true);
      }));

      // Cadre sur les deux, pour qu'on voie où ils se trouvent.
      const points = [plusProche, avecUrgences].filter(Boolean).map((h) => [h.lat, h.lon]);
      if (points.length > 1) global.MapView.cadrer(points, 70);
      else global.MapView.carte.flyTo([plusProche.lat, plusProche.lon], 13, { duration: 0.8 });
    },

    rafraichirListe() {
      const base = this.filtre === 'urgences' ? global.DataManager.hopitaux.filter(h => h.urgence)
        : this.filtre === 'garde' ? global.DataManager.hopitaux.filter(h => h.garde)
          : global.DataManager.hopitaux;
      // `distance` est en kilomètres, comme `rayonKm`.
      const liste = (this.rayonKm && this.position)
        ? base.filter(h => h.distance !== null && h.distance <= this.rayonKm)
        : base;
      // Le cercle de rayon suit toujours la liste affichée.
      if (this.position) {
        global.MapView.afficherPosition(this.position.lat, this.position.lon, this.rayonKm);
      }
      this.hopitauxCourants = liste;
      global.MapView.afficherHopitaux(liste);
      this.majFiltres();
      this.afficherListe(liste);
    },

    /* ---------------------------------------------------------------- */
    /* Itinéraire                                                       */
    /* ---------------------------------------------------------------- */
    async demarrerItineraire(hopital) {
      if (!this.position) {
        this.notifier('Activez d\'abord « Autour de moi » pour calculer un itinéraire.', 'erreur');
        return;
      }
      this.itineraire = hopital;
      this.fermerBottomSheetSurDesktop();
      this.chargement(true, 'Calcul de l\'itinéraire…');
      const res = await global.Routing.calculer(
        [this.position.lat, this.position.lon], [hopital.lat, hopital.lon], this.modeRoute);

      if (res.ok) {
        global.MapView.afficherRoute(res.geometry);
        // OSRM rend des kilomètres, l'interface affiche des mètres :
        // la conversion est faite ici, une seule fois.
        this.ouvrirPanneauRoute(hopital, res.distance * 1000, res.duree);
        this.chargement(false);
        // Cadre sur le trajet complet.
        global.MapView.cadrer(res.geometry, 50);
        return;
      }
      this.chargement(false);
      // Pas de simulation : on renvoie vers un service qui sait calculer.
      this.ouvrirPanneauRoute(hopital,
        global.GeoUtils.distanceKm(this.position.lat, this.position.lon, hopital.lat, hopital.lon) * 1000,
        null, res.raison);
      this.notifier('Calcul d\'itinéraire indisponible — ouverture du repli externe.', 'erreur', 7000);
    },

    /** `metres` en mètres, `minutes` en minutes (null = à estimer). */
    ouvrirPanneauRoute(hopital, metres, minutes, raison = null) {
      const p = $('#panneau-itineraire');
      const km = metres / 1000;
      const duree = minutes !== null
        ? `${Math.round(minutes)} min`
        : `≈ ${Math.round(global.Routing.estimerDuree(km, this.modeRoute))} min (estimation)`;
      p.innerHTML = `
        <div class="route-tete">
          <span class="route-kicker">Itinéraire</span>
          <h3>${UI.echapper(hopital.nom)}</h3>
          ${raison ? `<p class="route-raison">${UI.echapper(raison)}</p>` : ''}
          <div class="route-mesures">
            <span>📍 ${UI.formaterDistance(metres)}</span>
            <span>⏱ ${duree}</span>
          </div>
        </div>
        <div class="modes" role="group" aria-label="Mode de déplacement">
          <button type="button" data-mode="voiture" class="${this.modeRoute === 'voiture' ? 'actif' : ''}">🚗 Voiture</button>
          <button type="button" data-mode="marche" class="${this.modeRoute === 'marche' ? 'actif' : ''}">🚶 Marche</button>
          <button type="button" data-mode="velo" class="${this.modeRoute === 'velo' ? 'actif' : ''}">🚲 Vélo</button>
        </div>
        <button type="button" class="btn btn--principal" id="btn-recalculer">Recalculer</button>
        <a class="btn btn--secondaire" id="btn-externe" target="_blank" rel="noopener"
           href="${global.Routing.lienExterne([this.position.lat, this.position.lon], [hopital.lat, hopital.lon], this.modeRoute)}">
           Ouvrir dans un service externe
        </a>`;
      p.classList.add('ouvert');
      p.querySelectorAll('[data-mode]').forEach(b => b.addEventListener('click', () => {
        this.modeRoute = b.dataset.mode;
        this.demarrerItineraire(hopital);
      }));
      $('#btn-recalculer').addEventListener('click', () => this.demarrerItineraire(hopital));
    },

    fermerPanneauRoute() {
      $('#panneau-itineraire').classList.remove('ouvert');
      global.MapView.effacerRoute();
    },

    /* ---------------------------------------------------------------- */
    /* Recherche                                                        */
    /* ---------------------------------------------------------------- */
    brancherRecherche() {
      const champ = $('#recherche');
      const resultats = $('#resultats');
      let index = -1;

      const chercher = () => {
        const q = champ.value.trim().toLowerCase();
        if (q.length < 2) { resultats.classList.remove('ouvert'); return; }
        const communes = global.DataManager.communes
          .filter(c => c.nom.toLowerCase().includes(q)).slice(0, 6)
          .map(c => ({ type: 'commune', nom: c.nom, objet: c,
            detail: `${c.nbHopitaux} établissement${c.nbHopitaux > 1 ? 's' : ''}` }));
        const hops = global.DataManager.hopitaux
          .filter(h => h.nom.toLowerCase().includes(q) ||
            (h.ville && String(h.ville).toLowerCase().includes(q)))
          .slice(0, 8)
          .map(h => ({ type: 'hopital', nom: h.nom, objet: h,
            detail: h.commune || h.ville || '', urgence: h.urgence }));

        const tous = [...communes, ...hops];
        if (!tous.length) {
          resultats.innerHTML = '<p class="vide">Aucun résultat.</p>';
            resultats.classList.add('ouvert');
          return;
        }
        resultats.innerHTML = tous.map((r, i) => `
          <button type="button" class="resultat" data-i="${i}">
            <span class="resultat-ic">${r.type === 'commune' ? '◧' : '⌂'}</span>
            <span class="resultat-corps">
              <span class="resultat-nom">${UI.echapper(r.nom)}</span>
              <span class="resultat-detail">${UI.echapper(r.detail || '')}${r.urgence ? ' · urgences' : ''}</span>
            </span>
          </button>`).join('');
        resultats.classList.add('ouvert');
        resultats._tous = tous;
      };

      champ.addEventListener('input', chercher);
      champ.addEventListener('keydown', (e) => {
        const items = resultats.querySelectorAll('.resultat');
        if (e.key === 'ArrowDown') { index = Math.min(index + 1, items.length - 1); }
        else if (e.key === 'ArrowUp') { index = Math.max(index - 1, 0); }
        else if (e.key === 'Enter') { items[index >= 0 ? index : 0]?.click(); return; }
        else if (e.key === 'Escape') { resultats.classList.remove('ouvert'); return; }
        else return;
        e.preventDefault();
        items.forEach((it, i) => it.classList.toggle('survol', i === index));
        items[index]?.scrollIntoView({ block: 'nearest' });
      });

      resultats.addEventListener('click', (e) => {
        const b = e.target.closest('.resultat');
        if (!b) return;
        const r = resultats._tous[+b.dataset.i];
        resultats.classList.remove('ouvert');
        champ.value = r.nom;
        if (r.type === 'commune') {
          if (r.objet.centre) global.MapView.carte.flyTo(r.objet.centre, 13, { duration: 0.8 });
          global.MapView.selectionnerCommune(r.objet);
          UI.ouvrirFicheCommune(r.objet);
        } else {
          UI.ouvrirFicheHopital(r.objet, true);
        }
      });

      document.addEventListener('click', (e) => {
        if (!e.target.closest('.recherche-bloc')) resultats.classList.remove('ouvert');
      });
    },

    /* ---------------------------------------------------------------- */
    /* Utilitaires                                                      */
    /* ---------------------------------------------------------------- */
    echapper(s) {
      return String(s ?? '').replace(/[&<>"']/g, c =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    },

    formaterDistance(m) {
      if (m === null || m === undefined) return '—';
      return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1).replace('.', ',')} km`;
    },

    fermerBottomSheetSurDesktop() {
      if (window.innerWidth > 900) return;
      $('#panneau-itineraire').classList.remove('ouvert');
    },
  };

  global.UI = UI;
})(window);