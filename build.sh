#!/bin/sh
# Builds index.html from app.html (the app body) with a proper document head.
{ printf '<!doctype html>\n<html lang="en">\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">\n<meta name="theme-color" content="#1d3346">\n<link rel="manifest" href="/manifest.webmanifest">\n<link rel="icon" href="/favicon.png">\n<link rel="apple-touch-icon" href="/apple-touch-icon.png">\n<meta name="mobile-web-app-capable" content="yes">\n<meta name="apple-mobile-web-app-title" content="ZT-ERP">\n'; cat app.html; } > public/index.html
