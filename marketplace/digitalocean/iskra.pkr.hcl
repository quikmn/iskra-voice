# The Iskra 1-Click image for the DigitalOcean Marketplace.
# Build it with build.sh (it fetches and checks the server package first); see README.md. Never in CI without the
# owner's approval: it creates a temporary droplet in the DigitalOcean account the token belongs to.

packer {
  required_version = ">= 1.11.0"
  required_plugins {
    digitalocean = {
      version = "= 1.4.1"
      source  = "github.com/digitalocean/digitalocean"
    }
  }
}

variable "do_token" {
  type        = string
  sensitive   = true
  default     = env("DIGITALOCEAN_TOKEN")
  description = "A DigitalOcean API token for a project that only holds image builds."
}

variable "iskra_version" {
  type        = string
  description = "The Iskra release in the image, e.g. 2.0.0-alpha.16 (droplets update themselves after that)."
  validation {
    condition     = can(regex("^[0-9]+\\.[0-9]+\\.[0-9]+(-[0-9A-Za-z.]+)?$", var.iskra_version))
    error_message = "The version looks like 2.0.0 or 2.0.0-alpha.16."
  }
}

variable "package_dir" {
  type        = string
  default     = ""
  description = "Where the checked server package and SHA256SUMS.txt are (default: build/, where build.sh puts them)."
}

variable "region" {
  type    = string
  default = "nyc3"
}

# The smallest size with 1 GB: DigitalOcean asks for the smallest disk, so every size can use the image.
variable "size" {
  type    = string
  default = "s-1vcpu-1gb"
}

variable "base_image" {
  type    = string
  default = "ubuntu-24-04-x64"
}

locals {
  package_dir = var.package_dir != "" ? var.package_dir : "${path.root}/build"
  package     = "iskra-server-${var.iskra_version}-linux-x64.tar.gz"
  stamp       = formatdate("YYYYMMDD-hhmm", timestamp())
}

source "digitalocean" "iskra" {
  api_token          = var.do_token
  image              = var.base_image
  region             = var.region
  size               = var.size
  ssh_username       = "root"
  droplet_name       = "iskra-image-build"
  snapshot_name      = "iskra-${var.iskra_version}-${local.stamp}"
  monitoring         = false
  ipv6               = false
  private_networking = false
  tags               = ["iskra-image-build"]
}

build {
  sources = ["source.digitalocean.iskra"]

  provisioner "shell" {
    inline = ["cloud-init status --wait", "mkdir -p /tmp/iskra/files"]
  }

  provisioner "file" {
    sources     = ["${local.package_dir}/${local.package}", "${local.package_dir}/SHA256SUMS.txt"]
    destination = "/tmp/iskra/"
  }

  provisioner "file" {
    source      = "${path.root}/files/"
    destination = "/tmp/iskra/files"
  }

  # Install, then DigitalOcean's own cleanup and image check (vendor/, unchanged); the check must pass.
  provisioner "shell" {
    environment_vars = [
      "DEBIAN_FRONTEND=noninteractive",
      "LC_ALL=C",
      "ISKRA_VERSION=${var.iskra_version}",
    ]
    scripts = [
      "${path.root}/scripts/10-install.sh",
      "${path.root}/vendor/90-cleanup.sh",
      "${path.root}/vendor/99-img-check.sh",
    ]
  }
}
