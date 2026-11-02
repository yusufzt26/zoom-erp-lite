#!/bin/sh
# Builds index.html from app.html (the app body) with a proper document head.
{ printf '<!doctype html>\n<html lang="en">\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">\n<meta name="theme-color" content="#0e6e8c">\n<link rel="manifest" href="/manifest.webmanifest">\n<link rel="icon" href="/icon-192.png">\n<link rel="apple-touch-icon" href="/icon-192.png">\n'; cat app.html; } > public/index.html
