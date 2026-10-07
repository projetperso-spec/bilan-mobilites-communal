# Carreaux de population de 200 m (INSEE, Filosofi 2019), réduits au seul nombre d'habitants.
# Ils servent à calculer la part des habitants proches d'un aménagement cyclable ou d'un arrêt.
# Source : les fichiers par département déjà préparés par le projet diagnostic-climat-communal
# (script R/01_carreaux.R de ce projet, à partir des carreaux Filosofi 2019).
library(data.table)

entree <- "../diagnostic-climat-communal/docs/data/carreaux"
if (!file.exists(file.path(entree, "index.json"))) stop("Carreaux introuvables dans ", entree, " : voir le README.")
sortie <- "docs/data/carreaux"
dir.create(sortie, recursive = TRUE, showWarnings = FALSE)

fichiers <- list.files(entree, pattern = "\\.csv$")
for (f in fichiers) {
  d <- fread(file.path(entree, f), select = c("n", "e", "ind"))
  fwrite(d, file.path(sortie, f))
}
file.copy(file.path(entree, "index.json"), file.path(sortie, "index.json"), overwrite = TRUE)
cat(length(fichiers), "départements écrits dans", sortie, "\n")
