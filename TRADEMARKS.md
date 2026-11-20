# Trademarks

Fleetify's code is licensed under the [Apache License 2.0](LICENSE). The
Fleetify name and logo are not. Section 6 of the licence grants no permission
to use the licensor's trade names, trademarks or product names, beyond
describing where the code comes from and reproducing the [NOTICE](NOTICE)
file.

This page explains what you can do with them.

## What you can do without asking

You can use the name "Fleetify" to refer to the project, as long as nothing
suggests that the Fleetify project made, endorses or supports your work. For
example, you can:

- say that your tool, plugin or service "works with Fleetify";
- write, speak or teach about Fleetify;
- say that your fork is "based on Fleetify".

You don't need to rebrand a modified copy that you only run yourself.

## Forks must rebrand

If you distribute a modified version of Fleetify, give it its own identity, so
that nobody takes it for Fleetify or for an official build:

- **Name.** Don't call it Fleetify, or anything easily confused with it.
- **Logo.** Replace the Fleetify logo and icons in `public/`,
  `src-tauri/icons/` and `src/components/brand/` (the in-app mark is inline SVG
  in `logo-mark.tsx`).
- **App identifier.** Change `com.fleetify.app` (`identifier` in
  `src-tauri/tauri.conf.json`). It identifies official builds.
- **Update endpoint.** If your build enables the updater, point it at your own
  endpoint, never at Fleetify's update server.

## Questions

For anything this page doesn't cover, or to ask for permission, write to
[hello@fleetify.dev](mailto:hello@fleetify.dev).
