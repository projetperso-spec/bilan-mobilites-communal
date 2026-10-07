# Relevés enregistrés du réseau OpenStreetMap pour quelques communes (docs/data/reseau/<code>.json).
# Quand un relevé existe, le site l'affiche tout de suite au lieu d'interroger les serveurs publics
# d'OpenStreetMap, lents et souvent saturés. Les autres communes restent interrogées en direct.
# Usage : Rscript R/05_releves.R            (communes de la liste ci-dessous)
#         Rscript R/05_releves.R 92024 75118 (communes choisies)
# Les requêtes doivent rester identiques à celles de docs/app.js (requeteActuelle, requeteHistorique).
library(curl)
library(jsonlite)

communes <- commandArgs(trailingOnly = TRUE)
if (!length(communes)) communes <- c("92024", "93048", "94080", "92040", "93066", "78190")
sortie <- "docs/data/reseau"
dir.create(sortie, recursive = TRUE, showWarnings = FALSE)

MARGE_DEG <- 0.004
DATE_REFERENCE <- "2020-01-01"
SERVEURS <- c("https://overpass-api.de/api/interpreter", "https://maps.mail.ru/osm/tools/overpass/api/interpreter")
SERVEUR_HISTOIRE <- "https://overpass-api.de/api/interpreter"   # le seul qui remonte vraiment le temps
FILTRE_CYCLABLE <- '
  way["highway"="cycleway"];
  way["highway"~"^(path|footway|pedestrian|track|service)$"]["bicycle"="designated"];
  way["highway"]["cycleway"~"^(lane|track|share_busway|opposite_lane|opposite_track|opposite_share_busway)$"];
  way["highway"]["cycleway:left"~"^(lane|track|share_busway|opposite_lane|opposite_track)$"];
  way["highway"]["cycleway:right"~"^(lane|track|share_busway|opposite_lane|opposite_track)$"];
  way["highway"]["cycleway:both"~"^(lane|track|share_busway)$"];'
# Seuls les attributs lus par le site sont gardés, pour alléger les fichiers.
ATTRIBUTS <- c("highway", "cycleway", "cycleway:left", "cycleway:right", "cycleway:both", "bicycle", "foot", "segregated",
               "maxspeed", "zone:maxspeed", "source:maxspeed", "maxspeed:type", "oneway", "oneway:bicycle", "name", "ref",
               "amenity", "capacity", "covered", "bicycle_parking", "railway", "station", "subway")

interroger <- function(requete, serveurs, essais = 6, pause = 20) {
  for (i in seq_len(essais)) {
    serveur <- serveurs[(i - 1) %% length(serveurs) + 1]
    h <- new_handle(useragent = "bilan-mobilites-communal (projet personnel)", timeout = 200)
    handle_setopt(h, postfields = paste0("data=", curl_escape(requete)))
    r <- tryCatch(curl_fetch_memory(serveur, handle = h), error = function(e) NULL)
    if (!is.null(r) && r$status_code == 200) {
      d <- tryCatch(fromJSON(rawToChar(r$content), simplifyVector = FALSE), error = function(e) NULL)
      if (!is.null(d) && is.null(d$remark)) return(d)
    }
    cat("   essai", i, "sans réponse (", if (is.null(r)) "pas de connexion" else r$status_code, "), nouvelle tentative dans", pause, "s\n")
    Sys.sleep(pause)
  }
  NULL
}

alleger <- function(d) {
  lapply(d$elements, function(e) {
    x <- list(type = e$type, id = e$id, tags = e$tags[intersect(names(e$tags), ATTRIBUTS)])
    if (!is.null(e$lat)) { x$lat <- round(e$lat, 6); x$lon <- round(e$lon, 6) }
    if (!is.null(e$geometry)) x$geometry <- lapply(e$geometry, function(p) list(lat = round(p$lat, 6), lon = round(p$lon, 6)))
    if (is.null(e$geometry) && !is.null(e$bounds)) x$bounds <- e$bounds
    x
  })
}

for (code in communes) {
  contour <- fromJSON(sprintf("https://geo.api.gouv.fr/communes/%s?fields=nom&format=geojson&geometry=contour", code), simplifyVector = FALSE)
  xy <- matrix(unlist(contour$geometry$coordinates), ncol = 2, byrow = TRUE)
  bb <- sprintf("%.5f,%.5f,%.5f,%.5f", min(xy[, 2]) - MARGE_DEG, min(xy[, 1]) - MARGE_DEG, max(xy[, 2]) + MARGE_DEG, max(xy[, 1]) + MARGE_DEG)
  cat(code, contour$properties$nom, "\n")

  actuel <- interroger(sprintf('[out:json][timeout:90][bbox:%s];
    (%s
    way["highway"~"^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|pedestrian)(_link)?$"];
    nwr["amenity"="bicycle_parking"];
    node["amenity"="bicycle_rental"];
    node["highway"="bus_stop"];
    node["railway"~"^(station|halt|tram_stop)$"];
    );
    out tags geom;', bb, FILTRE_CYCLABLE), SERVEURS)
  if (is.null(actuel)) { cat("   réseau actuel indisponible : commune laissée de côté\n"); next }
  histoire <- interroger(sprintf('[out:json][timeout:170][date:"%sT00:00:00Z"][bbox:%s];(%s);out tags geom;', DATE_REFERENCE, bb, FILTRE_CYCLABLE),
                         SERVEUR_HISTOIRE)
  if (is.null(histoire)) cat("   réseau de 2020 indisponible : le site le demandera en direct\n")

  releve <- list(commune = code, date = format(Sys.Date()), actuel = list(elements = alleger(actuel)),
                 histoire = if (is.null(histoire)) NULL else list(elements = alleger(histoire)))
  fichier <- file.path(sortie, paste0(code, ".json"))
  write_json(releve, fichier, auto_unbox = TRUE, digits = NA, null = "null")
  cat("   ", length(releve$actuel$elements), "objets,", round(file.size(fichier) / 1e6, 1), "Mo\n")
}
