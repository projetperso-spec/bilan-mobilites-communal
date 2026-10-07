# Accidents corporels impliquant un piéton, un cycliste ou un engin de déplacement personnel
# (trottinette...), 2019-2024, tirés des fichiers BAAC de l'ONISR (data.gouv.fr).
# Un fichier par département, séparé par des tabulations (les adresses contiennent des virgules).
library(data.table)

dossier <- "data-brut/baac"
sortie <- "docs/data/accidents"
dir.create(sortie, recursive = TRUE, showWarnings = FALSE)
annees <- 2019:2024

lire <- function(type, an) {
  d <- fread(file.path(dossier, sprintf("%s-%d.csv", type, an)), sep = ";", colClasses = "character",
             encoding = "UTF-8", na.strings = c("", "NA"))
  setnames(d, "Accident_Id", "Num_Acc", skip_absent = TRUE)   # nom de colonne propre au fichier 2022
  d[, (names(d)) := lapply(.SD, trimws)]
  d
}

# Catégories de véhicules (catv) : https://www.data.gouv.fr (notice des bases ONISR).
VELO <- c("1", "80")                # bicyclette, vélo à assistance électrique
EDP  <- c("50", "60")               # engins de déplacement personnel, motorisés ou non
classe_vehicule <- function(catv) fcase(
  catv %in% c("7", "3"), "voiture",
  catv == "10", "utilitaire",
  catv %in% c("13", "14", "15", "16", "17", "20", "21"), "poids lourd",
  catv %in% c("37", "38"), "bus ou car",
  catv %in% c("39", "40"), "tramway ou train",
  catv %in% c("2", "30", "31", "32", "33", "34", "35", "36", "41", "42", "43"), "deux-roues motorisé",
  catv %in% VELO, "vélo",
  catv %in% EDP, "trottinette ou EDP",
  default = "autre")
# Gravité ONISR : 1 indemne, 2 tué, 3 blessé hospitalisé, 4 blessé léger. Rang : plus grand = plus grave.
rang_grav <- c("1" = 0L, "4" = 1L, "3" = 2L, "2" = 3L)
libelle_grav <- c("indemne", "blessé léger", "blessé hospitalisé", "tué")

tout <- rbindlist(lapply(annees, function(an) {
  car <- lire("caract", an)
  veh <- lire("vehicules", an)
  usa <- lire("usagers", an)

  # Chaque usager vulnérable : piéton (catu 3) ou occupant d'un vélo ou d'un EDP.
  usa <- merge(usa, veh[, .(Num_Acc, num_veh, catv)], by = c("Num_Acc", "num_veh"), all.x = TRUE)
  usa[, mode := fcase(catu == "3", "pieton",
                      catv %in% VELO, "velo",
                      catv %in% EDP, "edp",
                      default = NA_character_)]
  vul <- usa[!is.na(mode)]
  vul[, g := rang_grav[grav]]
  vul[is.na(g), g := 0L]

  par_acc <- vul[, .(
    pieton = as.integer(any(mode == "pieton")),
    velo   = as.integer(any(mode == "velo")),
    edp    = as.integer(any(mode == "edp")),
    victimes = sum(g > 0L),
    tues     = sum(g == 3L),
    hospit   = sum(g == 2L),
    gravite  = max(g)
  ), by = Num_Acc]

  # Véhicule en cause : le plus lourd des véhicules qui ne sont pas un vélo ou un EDP.
  ordre <- c("poids lourd", "bus ou car", "tramway ou train", "utilitaire", "voiture",
             "deux-roues motorisé", "vélo", "trottinette ou EDP", "autre")
  veh[, classe := classe_vehicule(catv)]
  autres <- veh[!(catv %in% c(VELO, EDP))]
  autres <- autres[Num_Acc %in% par_acc$Num_Acc]
  autres[, r := match(classe, ordre)]
  adverse <- autres[order(r), .(adverse = classe[1]), by = Num_Acc]

  x <- merge(par_acc, car, by = "Num_Acc")
  x <- merge(x, adverse, by = "Num_Acc", all.x = TRUE)
  x[is.na(adverse), adverse := "aucun autre véhicule"]
  cat(an, ":", nrow(x), "accidents avec piéton, cycliste ou EDP\n")
  x[, .(id = Num_Acc, annee = an, mois = as.integer(mois), heure = substr(hrmn, 1, 2),
        commune = com, lum, agg, int, adresse = adr,
        lat = as.numeric(sub(",", ".", lat, fixed = TRUE)),
        lon = as.numeric(sub(",", ".", long, fixed = TRUE)),
        pieton, velo, edp, victimes, tues, hospit, gravite, adverse)]
}))

# Coordonnées absentes ou manifestement fausses (0, 0) : écartées et comptées.
mauvais <- tout[is.na(lat) | is.na(lon) | (abs(lat) < 1 & abs(lon) < 1)]
cat("Sans coordonnées exploitables (écartés) :", nrow(mauvais), "sur", nrow(tout), "\n")
tout <- tout[!mauvais, on = "id"]
tout[, `:=`(lat = round(lat, 5), lon = round(lon, 5))]
tout[, adresse := gsub("[\t\r\n]+", " ", adresse)]
tout[, gravite := libelle_grav[gravite + 1L]]
tout[, dep := fifelse(substr(commune, 1, 2) == "97", substr(commune, 1, 3), substr(commune, 1, 2))]

for (dp in sort(unique(tout$dep))) {
  fwrite(tout[dep == dp, !"dep"], file.path(sortie, paste0(dp, ".tsv")), sep = "\t", quote = FALSE, na = "")
}
cat(uniqueN(tout$dep), "départements écrits dans", sortie, "\n")
print(tout[, .(accidents = .N, pieton = sum(pieton), velo = sum(velo), edp = sum(edp), tues = sum(tues)), by = annee])
