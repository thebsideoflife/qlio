terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }

  # Remote state so deploys can run from any checkout (laptop or harness
  # sandbox). Migrated from local state on 2026-07-02; the bucket is
  # versioned + encrypted, locking via DynamoDB table zeevee-tflock.
  backend "s3" {
    bucket         = "zeevee-tfstate-730898501390"
    key            = "zeevee/infrastructure.tfstate"
    region         = "us-west-2"
    profile        = "zeevee"
    dynamodb_table = "zeevee-tflock"
    encrypt        = true
  }
}

provider "aws" {
  region  = var.aws_region
  profile = var.profile
}

