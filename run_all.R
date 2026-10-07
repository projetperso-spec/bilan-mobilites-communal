# Reconstruit les fichiers par département lus par le site (docs/data).
# À lancer depuis la racine du projet, une fois les fichiers sources placés dans data-brut/.
for (script in c("R/01_accidents.R", "R/02_equipements.R", "R/03_parts_modales.R", "R/04_population.R")) {
  cat("\n==", script, "==\n")
  source(script, encoding = "UTF-8", local = new.env())
}
