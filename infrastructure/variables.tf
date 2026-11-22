variable "aws_region" {
  description = "AWS region"
  type        = string
  default     = "us-west-2"
}

variable "profile" {
  description = "AWS profile"
  type        = string
  default     = "zeevee"
}

variable "project_name" {
  description = "Project name"
  type        = string
  default     = "zeevee"
}


variable "stage" {
  description = "Stage (dev, prod)"
  type        = string
  default     = "dev"
}

variable "remotion_lambda_bucket" {
  description = "S3 bucket created by Remotion Lambda for site + render artifacts"
  type        = string
  default     = "remotionlambda-uswest2-0g1upoverr"
}

variable "twelve_labs_index_id" {
  description = "The Index ID from Twelve Labs"
  type        = string
  default     = "6934df867a1ec630b5fb65bd"
}

# ----------------------------------------------------------------------------
# Environment settings. The defaults are production's values, so the default
# workspace (prod) plans with no changes. infrastructure/envs/dev.tfvars
# overrides them for the dev environment (tofu workspace "dev").
# ----------------------------------------------------------------------------

variable "remotion_site_name" {
  description = "Remotion site (bundle) name under sites/ in the Remotion bucket"
  type        = string
  default     = "zeevee-renderer"
}

variable "remotion_function_name" {
  description = "Remotion render Lambda (deployed with the Remotion CLI; shared by all environments)"
  type        = string
  default     = "remotion-render-4-0-387-mem3008mb-disk10240mb-900sec"
}

variable "manage_remotion_bucket_cors" {
  description = "Manage CORS on the shared Remotion bucket. Only one environment may do this."
  type        = bool
  default     = true
}

variable "create_external_users" {
  description = "Create IAM users for external people (account-wide names; prod only)"
  type        = bool
  default     = true
}

variable "openrouter_secret_name" {
  description = "Existing OpenRouter secret to use. null means <project_name>/openrouter-api-key."
  type        = string
  default     = null
}
