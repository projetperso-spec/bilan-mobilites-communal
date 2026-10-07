# Établissements scolaires (écoles, collèges, lycées), tirés de la Base permanente des équipements 2025
# (INSEE). Ils servent à mesurer la desserte cyclable et le stationnement vélo autour des écoles.
# Un fichier par département, séparé par des tabulations.
library(arrow)
library(dplyr)
library(data.table)

# Le fichier BPE (170 Mo) est partagé avec le projet diagnostic-climat-communal : on le lit là-bas
# s'il n'a pas été copié ici.
source_bpe <- c("data-brut/BPE25.parquet", "../diagnostic-climat-communal/data-brut/BPE25.parquet")
source_bpe <- source_bpe[file.exists(source_bpe)][1]
if (is.na(source_bpe)) stop("BPE25.parquet introuvable : voir le README pour le télécharger.")

sortie <- "docs/data/equipements"
dir.create(sortie, recursive = TRUE, showWarnings = FALSE)

types <- c(C107 = "ecole", C108 = "ecole", C109 = "ecole",
           C201 = "college", C301 = "lycee", C302 = "lycee", C303 = "lycee")

bpe <- open_dataset(source_bpe) |>
  filter(TYPEQU %in% names(types)) |>
  select(DEPCOM, DEP, TYPEQU, NOMRS, LONGITUDE, LATITUDE) |>
  collect() |>
  as.data.table()

cat("Établissements retenus :", nrow(bpe), "\n")
cat("Sans coordonnées (écartés) :", bpe[is.na(LONGITUDE) | is.na(LATITUDE), .N], "\n")
bpe <- bpe[!is.na(LONGITUDE) & !is.na(LATITUDE)]
bpe[, type := types[TYPEQU]]
bpe[, nom := gsub("[\t\r\n]+", " ", trimws(NOMRS))]

for (dp in sort(unique(bpe$DEP))) {
  x <- bpe[DEP == dp, .(commune = DEPCOM, type, nom, lon = round(LONGITUDE, 5), lat = round(LATITUDE, 5))]
  fwrite(x, file.path(sortie, paste0(dp, ".tsv")), sep = "\t", quote = FALSE, na = "")
}
cat(uniqueN(bpe$DEP), "départements écrits dans", sortie, "\n")
