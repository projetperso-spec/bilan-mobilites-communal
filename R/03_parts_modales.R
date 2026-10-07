# Mode de transport principal pour aller travailler (actifs occupés de 15 ans ou plus),
# recensement de la population 2022 et 2016 (INSEE, base « Caractéristiques de l'emploi »).
# Attention : en 2016 l'INSEE ne sépare pas le vélo des deux-roues motorisés (« deux roues ») ;
# l'évolution 2016-2022 n'est donc calculable que pour la marche, la voiture et les transports en commun.
library(data.table)

sortie <- "docs/data/parts_modales"
dir.create(sortie, recursive = TRUE, showWarnings = FALSE)

d <- fread("data-brut/base-cc-caract_emp-2022.CSV", sep = ";", colClasses = c(CODGEO = "character"))
garder <- c("CODGEO",
            "P22_ACTOCC15P", "P22_ACTOCC15P_PASTRANS", "P22_ACTOCC15P_MARCHE", "P22_ACTOCC15P_VELO",
            "P22_ACTOCC15P_2ROUESMOT", "P22_ACTOCC15P_VOITURE", "P22_ACTOCC15P_COMMUN",
            "P22_ACTOCC15P_ILT1",
            "P16_ACTOCC15P", "P16_ACTOCC15P_PASTRANS", "P16_ACTOCC15P_MARCHE", "P16_ACTOCC15P_2ROUES",
            "P16_ACTOCC15P_VOITURE", "P16_ACTOCC15P_COMMUN")
d <- d[, ..garder]
noms <- c("commune", "actifs22", "aucun22", "marche22", "velo22", "drm22", "voiture22", "tc22", "sur_place22",
          "actifs16", "aucun16", "marche16", "deuxroues16", "voiture16", "tc16")
setnames(d, garder, noms)
num <- setdiff(noms, "commune")
d[, (num) := lapply(.SD, function(v) round(as.numeric(v), 1)), .SDcols = num]
d[, dep := fifelse(substr(commune, 1, 2) == "97", substr(commune, 1, 3), substr(commune, 1, 2))]

for (dp in sort(unique(d$dep))) {
  fwrite(d[dep == dp, !"dep"], file.path(sortie, paste0(dp, ".tsv")), sep = "\t", quote = FALSE, na = "")
}
# Référence nationale (France hors Mayotte), pour situer la commune.
france <- d[, lapply(.SD, sum, na.rm = TRUE), .SDcols = num]
jsonlite::write_json(as.list(france), file.path(sortie, "france.json"), auto_unbox = TRUE, digits = NA)
cat(uniqueN(d$dep), "départements écrits dans", sortie, "\n")
cat("Part du vélo en France (2022) :", round(100 * france$velo22 / france$actifs22, 2), "%\n")
