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

variable "twelve_labs_index_id" {
  description = "The Index ID from Twelve Labs"
  type        = string
  default     = "6934df867a1ec630b5fb65bd" 
}
