.pragma library
.import "proxmox.js" as Proxmox
.import "portainer.js" as Portainer
.import "truenas.js" as TrueNAS
.import "uptimekuma.js" as UptimeKuma
.import "healthchecks.js" as Healthchecks
.import "gatus.js" as Gatus

// Every adapter the plugin knows. Adding a service = one file in this folder
// plus one line here; nothing in the UI changes. See docs/ADAPTERS.md.
//
// Order here is the order service tabs appear in.
var all = {
    proxmox: Proxmox.adapter,
    portainer: Portainer.adapter,
    truenas: TrueNAS.adapter,
    uptimekuma: UptimeKuma.adapter,
    healthchecks: Healthchecks.adapter,
    gatus: Gatus.adapter,
}
var order = ["proxmox", "portainer", "truenas", "uptimekuma", "healthchecks", "gatus"]
