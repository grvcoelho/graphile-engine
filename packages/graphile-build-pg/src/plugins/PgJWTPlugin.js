// @flow
import type { Plugin } from "graphile-build";
import { sign as signJwt } from "jsonwebtoken";

export default (function PgJWTPlugin(
  builder,
  { pgJwtTypeIdentifier, pgJwtSecret }
) {
  builder.hook("init", (_, build) => {
    const {
      newWithHooks,
      pgSql: sql,
      pgIntrospectionResultsByKind: introspectionResultsByKind,
      pgRegisterGqlTypeByTypeId,
      pg2GqlMapper,
      pgTweaksByTypeId,
      graphql: { GraphQLScalarType },
      inflection,
      pgParseIdentifier: parseIdentifier,
      describePgEntity,
    } = build;

    if (!pgJwtTypeIdentifier) {
      return _;
    }
    if (!pgJwtSecret) {
      throw new Error("pgJwtTypeIdentifier was specified without pgJwtSecret");
    }
    const { namespaceName, entityName: typeName } = parseIdentifier(
      pgJwtTypeIdentifier
    );

    const compositeClass = introspectionResultsByKind.class.find(
      table =>
        !table.isSelectable &&
        !table.isInsertable &&
        !table.isUpdatable &&
        !table.isDeletable &&
        table.name === typeName &&
        table.namespaceName === namespaceName
    );
    if (!compositeClass) {
      throw new Error(
        `Could not find JWT type '"${namespaceName}"."${typeName}"'`
      );
    }
    const compositeType = compositeClass.type;
    if (!compositeType) {
      throw new Error("Could not determine the type for JWT type");
    }
    if (pg2GqlMapper[compositeType.id]) {
      throw new Error("JWT type has already been overridden?");
    }
    const attributes = compositeClass.attributes;

    const compositeTypeName = inflection.tableType(compositeClass);

    // NOTE: we deliberately do not create an input type
    pgRegisterGqlTypeByTypeId(compositeType.id, cb => {
      const JWTType = newWithHooks(
        GraphQLScalarType,
        {
          name: compositeTypeName,
          description:
            "A JSON Web Token defined by [RFC 7519](https://tools.ietf.org/html/rfc7519) which securely represents claims between two parties.",
          serialize(value) {
            const token = attributes.reduce((memo, attr) => {
              memo[attr.name] = value[attr.name];
              return memo;
            }, {});
            return signJwt(
              token,
              pgJwtSecret,
              Object.assign(
                {},
                token.aud
                  ? null
                  : {
                      audience: "postgraphile",
                    },
                token.iss
                  ? null
                  : {
                      issuer: "postgraphile",
                    },
                token.exp
                  ? null
                  : {
                      expiresIn: "1 day",
                    }
              )
            );
          },
        },
        {
          __origin: `Adding JWT type based on ${describePgEntity(
            compositeType
          )}`,
          isPgJwtType: true,
        }
      );
      cb(JWTType);

      pg2GqlMapper[compositeType.id] = {
        map: value => {
          if (!value) return null;
          const values = Object.values(value);
          if (values.some(v => v != null)) {
            return value;
          }
          return null;
        },
        unmap: () => {
          throw new Error(
            "We don't support passing a JWT token into GraphQL currently"
          );
        },
      };

      pgTweaksByTypeId[compositeType.id] = fragment =>
        sql.fragment`to_json(${fragment})`;
    });
    return _;
  });
}: Plugin);
