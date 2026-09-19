---
kind: research
---
```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["schemaVersion", "analysisStatus", "drawing", "rooms", "warnings"],
  "properties": {
    "schemaVersion": { "const": "1" },
    "analysisStatus": {
      "type": "string",
      "enum": ["complete", "partial", "not_floor_plan", "unreadable"]
    },
    "drawing": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "imageWidthPx",
        "imageHeightPx",
        "declaredUnit",
        "declaredScale",
        "calibrations",
        "globalCeilingHeight",
        "confidence",
        "warnings"
      ],
      "properties": {
        "imageWidthPx": { "type": "integer", "exclusiveMinimum": 0 },
        "imageHeightPx": { "type": "integer", "exclusiveMinimum": 0 },
        "declaredUnit": {
          "type": "object",
          "nullable": true,
          "additionalProperties": false,
          "required": ["value", "sourceText", "evidence", "confidence"],
          "properties": {
            "value": { "type": "string", "enum": ["mm", "cm", "m", "in", "ft"] },
            "sourceText": { "type": "string", "maxLength": 500 },
            "evidence": {
              "type": "array",
              "items": {
                "type": "object",
                "additionalProperties": false,
                "required": ["x", "y", "width", "height"],
                "properties": {
                  "x": { "type": "number", "minimum": 0, "maximum": 1 },
                  "y": { "type": "number", "minimum": 0, "maximum": 1 },
                  "width": { "type": "number", "exclusiveMinimum": 0, "maximum": 1 },
                  "height": { "type": "number", "exclusiveMinimum": 0, "maximum": 1 }
                }
              }
            },
            "confidence": { "type": "number", "minimum": 0, "maximum": 1 }
          }
        },
        "declaredScale": {
          "type": "object",
          "nullable": true,
          "additionalProperties": false,
          "required": ["sourceText", "evidence", "confidence"],
          "properties": {
            "sourceText": { "type": "string", "maxLength": 500 },
            "evidence": {
              "type": "array",
              "items": {
                "type": "object",
                "additionalProperties": false,
                "required": ["x", "y", "width", "height"],
                "properties": {
                  "x": { "type": "number", "minimum": 0, "maximum": 1 },
                  "y": { "type": "number", "minimum": 0, "maximum": 1 },
                  "width": { "type": "number", "exclusiveMinimum": 0, "maximum": 1 },
                  "height": { "type": "number", "exclusiveMinimum": 0, "maximum": 1 }
                }
              }
            },
            "confidence": { "type": "number", "minimum": 0, "maximum": 1 }
          }
        },
        "calibrations": {
          "type": "array",
          "maxItems": 20,
          "items": {
            "type": "object",
            "additionalProperties": false,
            "required": [
              "id",
              "kind",
              "sourceText",
              "evidence",
              "start",
              "end",
              "realLength",
              "confidence",
              "calculationEligibility"
            ],
            "properties": {
              "id": { "type": "string", "minLength": 1, "maxLength": 128 },
              "kind": { "type": "string", "enum": ["scale_bar", "dimension_anchor"] },
              "sourceText": { "type": "string", "maxLength": 500 },
              "evidence": {
                "type": "array",
                "items": {
                  "type": "object",
                  "additionalProperties": false,
                  "required": ["x", "y", "width", "height"],
                  "properties": {
                    "x": { "type": "number", "minimum": 0, "maximum": 1 },
                    "y": { "type": "number", "minimum": 0, "maximum": 1 },
                    "width": { "type": "number", "exclusiveMinimum": 0, "maximum": 1 },
                    "height": { "type": "number", "exclusiveMinimum": 0, "maximum": 1 }
                  }
                }
              },
              "start": {
                "type": "object",
                "additionalProperties": false,
                "required": ["x", "y"],
                "properties": {
                  "x": { "type": "number", "minimum": 0, "maximum": 1 },
                  "y": { "type": "number", "minimum": 0, "maximum": 1 }
                }
              },
              "end": {
                "type": "object",
                "additionalProperties": false,
                "required": ["x", "y"],
                "properties": {
                  "x": { "type": "number", "minimum": 0, "maximum": 1 },
                  "y": { "type": "number", "minimum": 0, "maximum": 1 }
                }
              },
              "realLength": {
                "type": "object",
                "additionalProperties": false,
                "required": [
                  "id",
                  "value",
                  "unit",
                  "unitSource",
                  "method",
                  "sourceText",
                  "evidence",
                  "calibrationId",
                  "confidence",
                  "calculationEligibility"
                ],
                "properties": {
                  "id": { "type": "string", "minLength": 1, "maxLength": 128 },
                  "value": { "type": "number", "exclusiveMinimum": 0 },
                  "unit": { "type": "string", "enum": ["mm", "cm", "m", "in", "ft"] },
                  "unitSource": { "type": "string", "enum": ["label", "drawing"] },
                  "method": { "type": "string", "enum": ["printed", "scale_derived"] },
                  "sourceText": { "type": "string", "nullable": true, "maxLength": 500 },
                  "evidence": {
                    "type": "array",
                    "items": {
                      "type": "object",
                      "additionalProperties": false,
                      "required": ["x", "y", "width", "height"],
                      "properties": {
                        "x": { "type": "number", "minimum": 0, "maximum": 1 },
                        "y": { "type": "number", "minimum": 0, "maximum": 1 },
                        "width": { "type": "number", "exclusiveMinimum": 0, "maximum": 1 },
                        "height": { "type": "number", "exclusiveMinimum": 0, "maximum": 1 }
                      }
                    }
                  },
                  "calibrationId": { "type": "string", "nullable": true, "minLength": 1, "maxLength": 128 },
                  "confidence": { "type": "number", "minimum": 0, "maximum": 1 },
                  "calculationEligibility": { "type": "string", "enum": ["eligible", "review_required"] }
                }
              },
              "confidence": { "type": "number", "minimum": 0, "maximum": 1 },
              "calculationEligibility": { "type": "string", "enum": ["eligible", "review_required"] }
            }
          }
        },
        "globalCeilingHeight": {
          "type": "object",
          "nullable": true,
          "additionalProperties": false,
          "required": [
            "id",
            "value",
            "unit",
            "unitSource",
            "method",
            "sourceText",
            "evidence",
            "calibrationId",
            "confidence",
            "calculationEligibility"
          ],
          "properties": {
            "id": { "type": "string", "minLength": 1, "maxLength": 128 },
            "value": { "type": "number", "exclusiveMinimum": 0 },
            "unit": { "type": "string", "enum": ["mm", "cm", "m", "in", "ft"] },
            "unitSource": { "type": "string", "enum": ["label", "drawing"] },
            "method": { "type": "string", "enum": ["printed", "scale_derived"] },
            "sourceText": { "type": "string", "nullable": true, "maxLength": 500 },
            "evidence": {
              "type": "array",
              "items": {
                "type": "object",
                "additionalProperties": false,
                "required": ["x", "y", "width", "height"],
                "properties": {
                  "x": { "type": "number", "minimum": 0, "maximum": 1 },
                  "y": { "type": "number", "minimum": 0, "maximum": 1 },
                  "width": { "type": "number", "exclusiveMinimum": 0, "maximum": 1 },
                  "height": { "type": "number", "exclusiveMinimum": 0, "maximum": 1 }
                }
              }
            },
            "calibrationId": { "type": "string", "nullable": true, "minLength": 1, "maxLength": 128 },
            "confidence": { "type": "number", "minimum": 0, "maximum": 1 },
            "calculationEligibility": { "type": "string", "enum": ["eligible", "review_required"] }
          }
        },
        "confidence": { "type": "number", "minimum": 0, "maximum": 1 },
        "warnings": {
          "type": "array",
          "maxItems": 100,
          "items": { "type": "string", "minLength": 1, "maxLength": 500 }
        }
      }
    },
    "rooms": {
      "type": "array",
      "maxItems": 100,
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "id",
          "printedName",
          "location",
          "floor",
          "walls",
          "openings",
          "confidence",
          "warnings",
          "readiness",
          "missingInputs"
        ],
        "properties": {
          "id": { "type": "string", "minLength": 1, "maxLength": 128 },
          "printedName": { "type": "string", "nullable": true, "minLength": 1, "maxLength": 500 },
          "location": { "type": "string", "minLength": 1, "maxLength": 500 },
          "floor": {
            "type": "object",
            "additionalProperties": false,
            "required": ["outerBoundary", "holes", "printedArea", "calculationEligibility"],
            "properties": {
              "outerBoundary": {
                "type": "array",
                "maxItems": 128,
                "items": {
                  "type": "object",
                  "additionalProperties": false,
                  "required": ["x", "y"],
                  "properties": {
                    "x": { "type": "number", "minimum": 0, "maximum": 1 },
                    "y": { "type": "number", "minimum": 0, "maximum": 1 }
                  }
                }
              },
              "holes": {
                "type": "array",
                "maxItems": 32,
                "items": {
                  "type": "object",
                  "additionalProperties": false,
                  "required": ["id", "boundary"],
                  "properties": {
                    "id": { "type": "string", "minLength": 1, "maxLength": 128 },
                    "boundary": {
                      "type": "array",
                      "maxItems": 128,
                      "items": {
                        "type": "object",
                        "additionalProperties": false,
                        "required": ["x", "y"],
                        "properties": {
                          "x": { "type": "number", "minimum": 0, "maximum": 1 },
                          "y": { "type": "number", "minimum": 0, "maximum": 1 }
                        }
                      }
                    }
                  }
                }
              },
              "printedArea": {
                "type": "object",
                "nullable": true,
                "additionalProperties": false,
                "required": [
                  "id",
                  "value",
                  "unit",
                  "unitSource",
                  "method",
                  "basis",
                  "sourceText",
                  "evidence",
                  "confidence",
                  "calculationEligibility"
                ],
                "properties": {
                  "id": { "type": "string", "minLength": 1, "maxLength": 128 },
                  "value": { "type": "number", "exclusiveMinimum": 0 },
                  "unit": { "type": "string", "enum": ["mm2", "cm2", "m2", "in2", "ft2"] },
                  "unitSource": { "type": "string", "enum": ["label", "drawing"] },
                  "method": { "const": "printed" },
                  "basis": { "type": "string", "enum": ["gross", "net", "unknown"] },
                  "sourceText": { "type": "string", "maxLength": 500 },
                  "evidence": {
                    "type": "array",
                    "items": {
                      "type": "object",
                      "additionalProperties": false,
                      "required": ["x", "y", "width", "height"],
                      "properties": {
                        "x": { "type": "number", "minimum": 0, "maximum": 1 },
                        "y": { "type": "number", "minimum": 0, "maximum": 1 },
                        "width": { "type": "number", "exclusiveMinimum": 0, "maximum": 1 },
                        "height": { "type": "number", "exclusiveMinimum": 0, "maximum": 1 }
                      }
                    }
                  },
                  "confidence": { "type": "number", "minimum": 0, "maximum": 1 },
                  "calculationEligibility": { "type": "string", "enum": ["eligible", "review_required"] }
                }
              },
              "calculationEligibility": { "type": "string", "enum": ["eligible", "review_required"] }
            }
          },
          "walls": {
            "type": "array",
            "maxItems": 128,
            "items": {
              "type": "object",
              "additionalProperties": false,
              "required": [
                "id",
                "start",
                "end",
                "length",
                "heightProfile",
                "startHeight",
                "endHeight",
                "usesGlobalHeight",
                "calculationEligibility"
              ],
              "properties": {
                "id": { "type": "string", "minLength": 1, "maxLength": 128 },
                "start": {
                  "type": "object",
                  "additionalProperties": false,
                  "required": ["x", "y"],
                  "properties": {
                    "x": { "type": "number", "minimum": 0, "maximum": 1 },
                    "y": { "type": "number", "minimum": 0, "maximum": 1 }
                  }
                },
                "end": {
                  "type": "object",
                  "additionalProperties": false,
                  "required": ["x", "y"],
                  "properties": {
                    "x": { "type": "number", "minimum": 0, "maximum": 1 },
                    "y": { "type": "number", "minimum": 0, "maximum": 1 }
                  }
                },
                "length": {
                  "type": "object",
                  "nullable": true,
                  "additionalProperties": false,
                  "required": [
                    "id",
                    "value",
                    "unit",
                    "unitSource",
                    "method",
                    "sourceText",
                    "evidence",
                    "calibrationId",
                    "confidence",
                    "calculationEligibility"
                  ],
                  "properties": {
                    "id": { "type": "string", "minLength": 1, "maxLength": 128 },
                    "value": { "type": "number", "exclusiveMinimum": 0 },
                    "unit": { "type": "string", "enum": ["mm", "cm", "m", "in", "ft"] },
                    "unitSource": { "type": "string", "enum": ["label", "drawing"] },
                    "method": { "type": "string", "enum": ["printed", "scale_derived"] },
                    "sourceText": { "type": "string", "nullable": true, "maxLength": 500 },
                    "evidence": {
                      "type": "array",
                      "items": {
                        "type": "object",
                        "additionalProperties": false,
                        "required": ["x", "y", "width", "height"],
                        "properties": {
                          "x": { "type": "number", "minimum": 0, "maximum": 1 },
                          "y": { "type": "number", "minimum": 0, "maximum": 1 },
                          "width": { "type": "number", "exclusiveMinimum": 0, "maximum": 1 },
                          "height": { "type": "number", "exclusiveMinimum": 0, "maximum": 1 }
                        }
                      }
                    },
                    "calibrationId": { "type": "string", "nullable": true, "minLength": 1, "maxLength": 128 },
                    "confidence": { "type": "number", "minimum": 0, "maximum": 1 },
                    "calculationEligibility": { "type": "string", "enum": ["eligible", "review_required"] }
                  }
                },
                "heightProfile": { "type": "string", "enum": ["constant", "sloped", "unknown"] },
                "startHeight": {
                  "type": "object",
                  "nullable": true,
                  "additionalProperties": false,
                  "required": [
                    "id",
                    "value",
                    "unit",
                    "unitSource",
                    "method",
                    "sourceText",
                    "evidence",
                    "calibrationId",
                    "confidence",
                    "calculationEligibility"
                  ],
                  "properties": {
                    "id": { "type": "string", "minLength": 1, "maxLength": 128 },
                    "value": { "type": "number", "exclusiveMinimum": 0 },
                    "unit": { "type": "string", "enum": ["mm", "cm", "m", "in", "ft"] },
                    "unitSource": { "type": "string", "enum": ["label", "drawing"] },
                    "method": { "type": "string", "enum": ["printed", "scale_derived"] },
                    "sourceText": { "type": "string", "nullable": true, "maxLength": 500 },
                    "evidence": {
                      "type": "array",
                      "items": {
                        "type": "object",
                        "additionalProperties": false,
                        "required": ["x", "y", "width", "height"],
                        "properties": {
                          "x": { "type": "number", "minimum": 0, "maximum": 1 },
                          "y": { "type": "number", "minimum": 0, "maximum": 1 },
                          "width": { "type": "number", "exclusiveMinimum": 0, "maximum": 1 },
                          "height": { "type": "number", "exclusiveMinimum": 0, "maximum": 1 }
                        }
                      }
                    },
                    "calibrationId": { "type": "string", "nullable": true, "minLength": 1, "maxLength": 128 },
                    "confidence": { "type": "number", "minimum": 0, "maximum": 1 },
                    "calculationEligibility": { "type": "string", "enum": ["eligible", "review_required"] }
                  }
                },
                "endHeight": {
                  "type": "object",
                  "nullable": true,
                  "additionalProperties": false,
                  "required": [
                    "id",
                    "value",
                    "unit",
                    "unitSource",
                    "method",
                    "sourceText",
                    "evidence",
                    "calibrationId",
                    "confidence",
                    "calculationEligibility"
                  ],
                  "properties": {
                    "id": { "type": "string", "minLength": 1, "maxLength": 128 },
                    "value": { "type": "number", "exclusiveMinimum": 0 },
                    "unit": { "type": "string", "enum": ["mm", "cm", "m", "in", "ft"] },
                    "unitSource": { "type": "string", "enum": ["label", "drawing"] },
                    "method": { "type": "string", "enum": ["printed", "scale_derived"] },
                    "sourceText": { "type": "string", "nullable": true, "maxLength": 500 },
                    "evidence": {
                      "type": "array",
                      "items": {
                        "type": "object",
                        "additionalProperties": false,
                        "required": ["x", "y", "width", "height"],
                        "properties": {
                          "x": { "type": "number", "minimum": 0, "maximum": 1 },
                          "y": { "type": "number", "minimum": 0, "maximum": 1 },
                          "width": { "type": "number", "exclusiveMinimum": 0, "maximum": 1 },
                          "height": { "type": "number", "exclusiveMinimum": 0, "maximum": 1 }
                        }
                      }
                    },
                    "calibrationId": { "type": "string", "nullable": true, "minLength": 1, "maxLength": 128 },
                    "confidence": { "type": "number", "minimum": 0, "maximum": 1 },
                    "calculationEligibility": { "type": "string", "enum": ["eligible", "review_required"] }
                  }
                },
                "usesGlobalHeight": { "type": "boolean" },
                "calculationEligibility": { "type": "string", "enum": ["eligible", "review_required"] }
              }
            }
          },
          "openings": {
            "type": "array",
            "maxItems": 64,
            "items": {
              "type": "object",
              "additionalProperties": false,
              "required": [
                "id",
                "kind",
                "wallId",
                "start",
                "end",
                "width",
                "height",
                "sillHeight",
                "calculationEligibility"
              ],
              "properties": {
                "id": { "type": "string", "minLength": 1, "maxLength": 128 },
                "kind": { "type": "string", "enum": ["door", "window", "opening", "unknown"] },
                "wallId": { "type": "string", "nullable": true, "minLength": 1, "maxLength": 128 },
                "start": {
                  "type": "object",
                  "nullable": true,
                  "additionalProperties": false,
                  "required": ["x", "y"],
                  "properties": {
                    "x": { "type": "number", "minimum": 0, "maximum": 1 },
                    "y": { "type": "number", "minimum": 0, "maximum": 1 }
                  }
                },
                "end": {
                  "type": "object",
                  "nullable": true,
                  "additionalProperties": false,
                  "required": ["x", "y"],
                  "properties": {
                    "x": { "type": "number", "minimum": 0, "maximum": 1 },
                    "y": { "type": "number", "minimum": 0, "maximum": 1 }
                  }
                },
                "width": {
                  "type": "object",
                  "nullable": true,
                  "additionalProperties": false,
                  "required": [
                    "id",
                    "value",
                    "unit",
                    "unitSource",
                    "method",
                    "sourceText",
                    "evidence",
                    "calibrationId",
                    "confidence",
                    "calculationEligibility"
                  ],
                  "properties": {
                    "id": { "type": "string", "minLength": 1, "maxLength": 128 },
                    "value": { "type": "number", "exclusiveMinimum": 0 },
                    "unit": { "type": "string", "enum": ["mm", "cm", "m", "in", "ft"] },
                    "unitSource": { "type": "string", "enum": ["label", "drawing"] },
                    "method": { "type": "string", "enum": ["printed", "scale_derived"] },
                    "sourceText": { "type": "string", "nullable": true, "maxLength": 500 },
                    "evidence": {
                      "type": "array",
                      "items": {
                        "type": "object",
                        "additionalProperties": false,
                        "required": ["x", "y", "width", "height"],
                        "properties": {
                          "x": { "type": "number", "minimum": 0, "maximum": 1 },
                          "y": { "type": "number", "minimum": 0, "maximum": 1 },
                          "width": { "type": "number", "exclusiveMinimum": 0, "maximum": 1 },
                          "height": { "type": "number", "exclusiveMinimum": 0, "maximum": 1 }
                        }
                      }
                    },
                    "calibrationId": { "type": "string", "nullable": true, "minLength": 1, "maxLength": 128 },
                    "confidence": { "type": "number", "minimum": 0, "maximum": 1 },
                    "calculationEligibility": { "type": "string", "enum": ["eligible", "review_required"] }
                  }
                },
                "height": {
                  "type": "object",
                  "nullable": true,
                  "additionalProperties": false,
                  "required": [
                    "id",
                    "value",
                    "unit",
                    "unitSource",
                    "method",
                    "sourceText",
                    "evidence",
                    "calibrationId",
                    "confidence",
                    "calculationEligibility"
                  ],
                  "properties": {
                    "id": { "type": "string", "minLength": 1, "maxLength": 128 },
                    "value": { "type": "number", "exclusiveMinimum": 0 },
                    "unit": { "type": "string", "enum": ["mm", "cm", "m", "in", "ft"] },
                    "unitSource": { "type": "string", "enum": ["label", "drawing"] },
                    "method": { "type": "string", "enum": ["printed", "scale_derived"] },
                    "sourceText": { "type": "string", "nullable": true, "maxLength": 500 },
                    "evidence": {
                      "type": "array",
                      "items": {
                        "type": "object",
                        "additionalProperties": false,
                        "required": ["x", "y", "width", "height"],
                        "properties": {
                          "x": { "type": "number", "minimum": 0, "maximum": 1 },
                          "y": { "type": "number", "minimum": 0, "maximum": 1 },
                          "width": { "type": "number", "exclusiveMinimum": 0, "maximum": 1 },
                          "height": { "type": "number", "exclusiveMinimum": 0, "maximum": 1 }
                        }
                      }
                    },
                    "calibrationId": { "type": "string", "nullable": true, "minLength": 1, "maxLength": 128 },
                    "confidence": { "type": "number", "minimum": 0, "maximum": 1 },
                    "calculationEligibility": { "type": "string", "enum": ["eligible", "review_required"] }
                  }
                },
                "sillHeight": {
                  "type": "object",
                  "nullable": true,
                  "additionalProperties": false,
                  "required": [
                    "id",
                    "value",
                    "unit",
                    "unitSource",
                    "method",
                    "sourceText",
                    "evidence",
                    "calibrationId",
                    "confidence",
                    "calculationEligibility"
                  ],
                  "properties": {
                    "id": { "type": "string", "minLength": 1, "maxLength": 128 },
                    "value": { "type": "number", "exclusiveMinimum": 0 },
                    "unit": { "type": "string", "enum": ["mm", "cm", "m", "in", "ft"] },
                    "unitSource": { "type": "string", "enum": ["label", "drawing"] },
                    "method": { "type": "string", "enum": ["printed", "scale_derived"] },
                    "sourceText": { "type": "string", "nullable": true, "maxLength": 500 },
                    "evidence": {
                      "type": "array",
                      "items": {
                        "type": "object",
                        "additionalProperties": false,
                        "required": ["x", "y", "width", "height"],
                        "properties": {
                          "x": { "type": "number", "minimum": 0, "maximum": 1 },
                          "y": { "type": "number", "minimum": 0, "maximum": 1 },
                          "width": { "type": "number", "exclusiveMinimum": 0, "maximum": 1 },
                          "height": { "type": "number", "exclusiveMinimum": 0, "maximum": 1 }
                        }
                      }
                    },
                    "calibrationId": { "type": "string", "nullable": true, "minLength": 1, "maxLength": 128 },
                    "confidence": { "type": "number", "minimum": 0, "maximum": 1 },
                    "calculationEligibility": { "type": "string", "enum": ["eligible", "review_required"] }
                  }
                },
                "calculationEligibility": { "type": "string", "enum": ["eligible", "review_required"] }
              }
            }
          },
          "confidence": { "type": "number", "minimum": 0, "maximum": 1 },
          "warnings": {
            "type": "array",
            "maxItems": 100,
            "items": { "type": "string", "minLength": 1, "maxLength": 500 }
          },
          "readiness": {
            "type": "object",
            "additionalProperties": false,
            "required": ["floorArea", "grossWallArea", "netWallArea"],
            "properties": {
              "floorArea": { "type": "string", "enum": ["eligible", "review_required"] },
              "grossWallArea": { "type": "string", "enum": ["eligible", "review_required"] },
              "netWallArea": { "type": "string", "enum": ["eligible", "review_required"] }
            }
          },
          "missingInputs": {
            "type": "array",
            "items": {
              "type": "object",
              "additionalProperties": false,
              "required": ["code", "targetId"],
              "properties": {
                "code": {
                  "type": "string",
                  "enum": [
                    "scale_missing",
                    "floor_boundary_incomplete",
                    "ceiling_height_missing",
                    "height_scope_ambiguous",
                    "wall_length_missing",
                    "opening_width_missing",
                    "opening_height_missing",
                    "opening_wall_ambiguous"
                  ]
                },
                "targetId": { "type": "string", "nullable": true, "minLength": 1, "maxLength": 128 }
              }
            }
          }
        }
      }
    },
    "warnings": {
      "type": "array",
      "maxItems": 100,
      "items": { "type": "string", "minLength": 1, "maxLength": 500 }
    }
  }
}
```

The schema describes the caller-facing `data` object. Pass the complete `{ "kind": "research", "data": { ... } }` envelope as the `outcome` argument of `submit_outcome`. The `data` value must be exactly the object returned by `property_documents.extract_room_measurements`, unchanged and without an additional wrapper. Do not include file paths, attachment IDs, calculations, hidden reasoning, retries, summaries, or additional fields.
