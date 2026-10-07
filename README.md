# Habit Tracker

Persönlicher Habit Tracker als Web-App (PWA): Gewohnheiten aufbauen und abgewöhnen, Streaks, Heatmaps, Statistiken und ein täglicher Score.

Live: https://cemseo.github.io/habit-tracker/

Login und Daten laufen über Firebase (Authentication + Firestore). Die Firebase-Konfiguration in `index.html` ist öffentlich und kein Geheimnis; der Zugriff ist über Firestore-Regeln abgesichert (jeder Nutzer liest und schreibt nur `users/{uid}/…`).
