/**
 * Routing — calcul d'itinéraire multimodal.
 *
 * OSRM (démo publique) sert le tracé réel pour la voiture, la marche et le
 * vélo. En cas d'indisponibilité, on ne simule pas de trajet : on propose
 * l'itinéraire dans un service de cartographie externe, qui est la seule
 * réponse fiable possible sans serveur de calcul.
 */
(function (global) {
  'use strict';

  const OSRM = 'https://router.project-osrm.org/route/v1';
  // Vitesses de référence, uniquement pour l'estimation d'affichage quand le
  // service ne renvoie pas de durée.
  const VITESSES = { voiture: 50, marche: 4.5, velo: 15 }; // km/h

  /** Deux points → une URL OSRM.
 *  Leaflet travaille en [lat, lon], OSRM exige [lon, lat] : l'inversion est
 *  silencieuse et produit un itinéraire plausible mais géographiquement faux. */
  function urlOSRM(depart, arrivee, mode) {
    const profil = mode === 'voiture' ? 'driving' : mode === 'marche' ? 'foot' : 'bike';
    const d = `${depart[1]},${depart[0]}`;
    const a = `${arrivee[1]},${arrivee[0]}`;
    // overview=full : géométrie complète pour le tracé à l'écran.
    return `${OSRM}/${profil}/${d};${a}?overview=full&geometries=geojson&steps=false`;
  }

  const Routing = {
    /**
     * Demande un itinéraire. Renvoie `{ ok, geometry, distance, duree, mode }`
     * ou `{ ok: false, raison }` — jamais une fausse géométrie.
     */
    async calculer(depart, arrivee, mode = 'voiture') {
      try {
        const r = await fetch(urlOSRM(depart, arrivee, mode), { cache: 'no-store' });
        if (!r.ok) throw new Error(`service indisponible (${r.status})`);
        const j = await r.json();
        if (j.code !== 'Ok' || !j.routes || !j.routes.length) {
          throw new Error(j.message || 'aucun itinéraire trouvé');
        }
        const route = j.routes[0];
        return {
          ok: true,
          geometry: route.geometry.coordinates.map(c => [c[1], c[0]]), // lon,lat → lat,lon
          distance: route.distance / 1000,
          duree: route.duration / 60,
          mode: mode,
        };
      } catch (e) {
        return { ok: false, raison: e.message || 'service d\'itinéraire indisponible', mode };
      }
    },

    /** Estimation de durée, uniquement d'après la distance. */
    estimerDuree(km, mode = 'voiture') {
      return (km / (VITESSES[mode] || VITESSES.voiture)) * 60;
    },

    /** Repli : itinéraire à calculer dans un service externe. */
    lienExterne(depart, arrivee, mode = 'voiture') {
      // OSM attend aussi [lon, lat].
      return 'https://www.openstreetmap.org/directions?engine=fossgis_osrm_car'
        + `&route=${depart[1]},${depart[0]};${arrivee[1]},${arrivee[0]}`;
    },
  };

  global.Routing = Routing;
})(window);